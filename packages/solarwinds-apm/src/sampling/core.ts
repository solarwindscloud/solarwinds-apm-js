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

import {
  type Attributes,
  type Context,
  type DiagLogger,
  SpanKind,
} from "@opentelemetry/api"
import {
  SEMATTRS_HTTP_SCHEME,
  SEMATTRS_HTTP_TARGET,
  SEMATTRS_NET_HOST_NAME,
} from "@opentelemetry/semantic-conventions"
import {
  type LocalSettings,
  OboeSampler,
  type RequestHeaders,
  type ResponseHeaders,
  TracingMode,
} from "@solarwinds-apm/sampling"

import { type ExtendedSwConfiguration } from "../config.js"
import { HEADERS_STORAGE } from "../propagation/headers.js"

export abstract class CoreSampler extends OboeSampler {
  readonly #tracingMode: TracingMode | undefined
  readonly #triggerMode: boolean
  readonly #transactionSettings: ExtendedSwConfiguration["transactionSettings"]

  constructor(config: ExtendedSwConfiguration, logger: DiagLogger) {
    super(logger)

    if (config.tracingMode !== undefined) {
      this.#tracingMode = config.tracingMode
        ? TracingMode.ALWAYS
        : TracingMode.NEVER
    }
    this.#triggerMode = config.triggerTraceEnabled
    this.#transactionSettings = config.transactionSettings
  }

  protected override localSettings(
    _context: Context,
    _traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
  ): LocalSettings {
    const settings: LocalSettings = {
      tracingMode: this.#tracingMode,
      triggerMode: this.#triggerMode,
    }

    if (!this.#transactionSettings) {
      return settings
    }

    const kind = SpanKind[spanKind]

    const scheme = attributes[SEMATTRS_HTTP_SCHEME]?.toString()
    const address = attributes[SEMATTRS_NET_HOST_NAME]?.toString()
    const path = attributes[SEMATTRS_HTTP_TARGET]?.toString()

    let identifier: string
    if (scheme && address && path) {
      identifier = `${scheme}://${address}${path}`
    } else {
      identifier = `${kind}:${spanName}`
    }

    for (const { tracing, matcher } of this.#transactionSettings) {
      if (matcher(identifier)) {
        settings.tracingMode = tracing ? TracingMode.ALWAYS : TracingMode.NEVER
        break
      }
    }

    return settings
  }

  protected override requestHeaders(context: Context): RequestHeaders {
    return HEADERS_STORAGE.get(context)?.request ?? {}
  }

  protected override setResponseHeaders(
    headers: ResponseHeaders,
    context: Context,
  ): void {
    const storage = HEADERS_STORAGE.get(context)
    if (storage) {
      Object.assign(storage.response, headers)
    }
  }
}
