/*
Copyright 2023 SolarWinds Worldwide, LLC.

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

import { createRequire } from "@solarwinds-apm/require"
import { expect, it } from "@solarwinds-apm/test"

import { dependencies } from "../src"

const packageJson = createRequire()("../package.json") as {
  devDependencies: Record<string, string>
}

for (const name of Object.keys(packageJson.devDependencies)) {
  it(`detects ${name}`, async () => {
    const deps = await dependencies()
    expect(deps.has(name)).to.be.true
  })
}
