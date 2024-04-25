/*
Copyright 2023-2024 SolarWinds Worldwide, LLC.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import * as dns from "node:dns/promises"
import { hostname } from "node:os"
import { TextDecoder } from "node:util"

import { type CallOptions, Client, credentials, Metadata } from "@grpc/grpc-js"
import { context, type DiagLogger } from "@opentelemetry/api"
import { suppressTracing } from "@opentelemetry/core"
import { collector } from "@solarwinds-apm/proto"
import {
  type BucketSettings,
  BucketType,
  Flags,
  type Settings,
} from "@solarwinds-apm/sampling"
import { type SwConfiguration } from "@solarwinds-apm/sdk"

import { CoreSampler } from "./core.js"

const CLIENT_VERSION = "2"

const REQUEST_TIMEOUT = 10 * 1000 // 10s
const RETRY_MIN_TIMEOUT = 500 // 500ms
const RETRY_MAX_TIMEOUT = 10 * 60 * 1000 // 10 minutes
const MULTIPLIER = 1.5

/** Map of flag names to their value */
const FLAGS_NAMES: Record<string, Flags | undefined> = {
  OVERRIDE: Flags.OVERRIDE,
  SAMPLE_START: Flags.SAMPLE_START,
  SAMPLE_THROUGH_ALWAYS: Flags.SAMPLE_THROUGH_ALWAYS,
  TRIGGER_TRACE: Flags.TRIGGERED_TRACE,
}

const BUCKET_CAPACITY = "BucketCapacity"
const BUCKET_RATE = "BucketRate"
const TRIGGER_RELAXED_BUCKET_CAPACITY = "TriggerRelaxedBucketCapacity"
const TRIGGER_RELAXED_BUCKET_RATE = "TriggerRelaxedBucketRate"
const TRIGGER_STRICT_BUCKET_CAPACITY = "TriggerStrictBucketCapacity"
const TRIGGER_STRICT_BUCKET_RATE = "TriggerStrictBucketRate"
const SIGNATURE_KEY = "SignatureKey"

/** Sampler that retrieves settings from the SWO collector directly via gRPC */
export class GrpcSampler extends CoreSampler {
  readonly #key: string
  readonly #address: URL
  readonly #hostname = hostname()

  #client: CollectorClient
  #lastWarningMessage = ""

  /** Resolves once the sampler has received settings */
  readonly ready: Promise<void>
  #ready!: () => void

  constructor(config: SwConfiguration, logger: DiagLogger) {
    super(config, logger)

    this.#key = `${config.token}:${config.serviceName}`

    // convert the collector string into a valid full URL
    let collector = config.collector!
    if (!/:{0-9}+$/.test(collector)) {
      collector = `${collector}:443`
    }
    if (!/^https?:/.test(collector)) {
      collector = `https://${collector}`
    }

    try {
      this.#address = new URL(collector)

      // on Alpine the grpc.Client constructor will hang forever if the hostname can't resolve
      // to avoid this we try to resolve before actually instantiating it
      const resolve = Promise.any([
        dns.resolve4(this.#address.hostname),
        dns.resolve6(this.#address.hostname),
      ])

      // create a temporary client that checks the hostname can be resolved
      // before replacing itself with the real thing
      this.#client = {
        getSettings: (request, response) =>
          resolve
            .then(() => {
              const cred = config.certificate
                ? credentials.createSsl(Buffer.from(config.certificate))
                : credentials.createSsl()

              // at this point we know the hostname resolves so
              // we can replace the temporary client
              this.#client = new GrpcCollectorClient(this.#address.host, cred)
              return this.#client.getSettings(request, response)
            })
            .catch((cause: unknown) =>
              // if the hostname doesn't resolve we just always return an error
              Promise.reject(
                new Error(`Invalid collector (${config.collector!})`, {
                  cause,
                }),
              ),
            ),
      }
    } catch (cause) {
      // this should only happen if the collector setting is set
      // to complete gibberish
      this.#address = new URL("https://collector.invalid:443")
      this.#client = {
        getSettings: () =>
          Promise.reject(
            new Error(`Invalid collector (${config.collector!})`, {
              cause,
            }),
          ),
      }
    }

    this.ready = new Promise((resolve) => (this.#ready = resolve))

    setImmediate(() => {
      this.#loop()
    }).unref()
  }

  override toString(): string {
    return `gRPC Sampler (${this.#address.host})`
  }

  /** Logs a de-duplicated warning */
  #warn(message: string, ...args: unknown[]) {
    if (message === this.#lastWarningMessage) {
      return
    }

    this.logger.warn(message, ...args)
    this.#lastWarningMessage = message
  }

  #loop(retryTimeout = RETRY_MIN_TIMEOUT) {
    const retry = () => {
      this.#ready()

      this.logger.debug(`retrying in ${(retryTimeout / 1000).toFixed(1)}s`)
      const nextRetryTimeout = Math.min(
        retryTimeout * MULTIPLIER,
        RETRY_MAX_TIMEOUT,
      )
      setTimeout(() => {
        this.#loop(nextRetryTimeout)
      }, retryTimeout).unref()
    }

    this.logger.debug("retrieving sampling settings")
    this.#client
      .getSettings(
        {
          apiKey: this.#key,
          identity: { hostname: this.#hostname },
          clientVersion: CLIENT_VERSION,
        },
        { options: { deadline: Date.now() + REQUEST_TIMEOUT } },
      )
      .then((response) => {
        if (!response) {
          this.logger.debug("empty response from collector")
          retry()
          return
        }

        this.logger.debug("retrieved sampling settings", response)
        if (response.warning) {
          this.#warn(response.warning)
        }

        if (
          response.result === collector.ResultCode.TRY_LATER ||
          response.result === collector.ResultCode.LIMIT_EXCEEDED
        ) {
          this.logger.debug("collector asked to retry later")
          retry()
          return
        } else if (response.result !== collector.ResultCode.OK) {
          this.logger.debug("collector returned error status", response.result)
          retry()
          return
        }

        const unparsed = response.settings?.find(
          ({ type }) => type === collector.OboeSettingType.DEFAULT_SAMPLE_RATE,
        )
        const parsed = unparsed && parseSettings(unparsed)
        if (!parsed) {
          this.#warn(
            "Retrieved sampling settings are invalid",
            "If you are connecting to an AppOptics collector please set the 'SW_APM_LEGACY' environment variable.",
          )
          retry()
          return
        }

        this.updateSettings(parsed)
        this.#ready()

        // this is pretty arbitrary but the goal is to update the settings
        // before the previous ones expire with some time to spare
        const nextRequestTimeout =
          parsed.ttl * 1000 - REQUEST_TIMEOUT * MULTIPLIER
        setTimeout(
          () => {
            this.#loop()
          },
          Math.max(0, nextRequestTimeout),
        ).unref()
      })
      .catch((error: unknown) => {
        let message = "Failed to retrieve sampling settings"
        if (error instanceof Error) {
          message += ` (${error.message})`
        }
        this.#warn(message, error)

        retry()
      })
  }
}

export interface CollectorRequestOptions {
  /** gRPC metadata */
  metadata?: Metadata
  /** gRPC call options */
  options?: CallOptions
  /** Optional abort signal */
  signal?: AbortSignal
}

interface CollectorClient {
  getSettings(
    request: collector.ISettingsRequest,
    options?: CollectorRequestOptions,
  ): Promise<collector.ISettingsResult | undefined>
}

/** gRPC client for the SWO collector */
export class GrpcCollectorClient extends Client implements CollectorClient {
  getSettings(
    request: collector.ISettingsRequest,
    options: CollectorRequestOptions = {},
  ): Promise<collector.ISettingsResult | undefined> {
    return new Promise((resolve, reject) => {
      context.with(suppressTracing(context.active()), () => {
        const call = this.makeUnaryRequest<
          collector.ISettingsRequest,
          collector.ISettingsResult
        >(
          "/collector.TraceCollector/getSettings",
          (req) => Buffer.from(collector.SettingsRequest.encode(req).finish()),
          (res) => collector.SettingsResult.decode(res),
          request,

          options.metadata ?? new Metadata(),
          options.options ?? {},

          (err, res) => {
            if (err) reject(err)
            else resolve(res)
          },
        )

        options.signal?.addEventListener("abort", () => {
          call.cancel()
        })
      })
    })
  }
}

/** Converts settings received from the gRPC collector into the internal representation */
export function parseSettings(
  unparsed: collector.IOboeSetting,
): Settings | undefined {
  if (!unparsed.ttl) {
    return undefined
  }

  const settings: Settings = {
    sampleRate: unparsed.value ?? 0,
    flags: Flags.OK,
    buckets: {},
    ttl: unparsed.ttl,
  }
  const decoder = new TextDecoder("utf-8", { fatal: false })

  const flagNames = decoder.decode(unparsed.flags ?? new Uint8Array([]))
  for (const flagName of flagNames.split(",")) {
    const flagValue = FLAGS_NAMES[flagName]
    if (flagValue != undefined) {
      settings.flags |= flagValue
    }
  }

  for (const [key, value] of Object.entries(unparsed.arguments ?? {})) {
    switch (key) {
      case BUCKET_CAPACITY: {
        parseBucketSetting(settings, BucketType.DEFAULT, "capacity", value)
        break
      }
      case BUCKET_RATE: {
        parseBucketSetting(settings, BucketType.DEFAULT, "rate", value)
        break
      }
      case TRIGGER_RELAXED_BUCKET_CAPACITY: {
        parseBucketSetting(
          settings,
          BucketType.TRIGGER_RELAXED,
          "capacity",
          value,
        )
        break
      }
      case TRIGGER_RELAXED_BUCKET_RATE: {
        parseBucketSetting(settings, BucketType.TRIGGER_RELAXED, "rate", value)
        break
      }
      case TRIGGER_STRICT_BUCKET_CAPACITY: {
        parseBucketSetting(
          settings,
          BucketType.TRIGGER_STRICT,
          "capacity",
          value,
        )
        break
      }
      case TRIGGER_STRICT_BUCKET_RATE: {
        parseBucketSetting(settings, BucketType.TRIGGER_STRICT, "rate", value)
        break
      }
      case SIGNATURE_KEY: {
        settings.signatureKey = value
      }
    }
  }

  return settings
}

function parseBucketSetting(
  settings: Settings,
  type: BucketType,
  key: keyof BucketSettings,
  value: Uint8Array,
): void {
  const bucket = settings.buckets[type] ?? { capacity: 0, rate: 0 }
  try {
    const parsed = Buffer.from(value).readDoubleLE()
    bucket[key] = parsed
    settings.buckets[type] = bucket
  } catch {
    return
  }
}
