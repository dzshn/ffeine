# ffeine

A tiny alternative to `web-ext run`, for usage in build scripts.

## Usage

Only Firefox is supported (at least as of now). Ffeine will automatically pick Firefox Developer Edition, Nightly, Beta, ESR or Stable (in that order) and not much setup is required:

```typescript
import { Firefox } from "ffeine";

async function main() {
    const browser = new Firefox();
    const extension = await browser.installExtension("dist/extension.zip");

    // later
    await browser.reloadExtension(extension);

    // reinstalling the extension is also ok if the manifest has an id
    await browser.installExtension("dist/extension.zip")
}
```

The following options may be provided as the first argument to `Firefox`:

```typescript
interface BrowserOptions {
    /**
     * Initial URL to open the browser window at.
     */
    url?: string;
    /**
     * Suppress log messages below this level. Defaults to "warn".
     */
    logLevel?: LogLevelStr;
    /**
     * The name shown on logs from this instance (e.g. `firefox`).
     */
    logName?: string;
    /**
     * Path to the browser's binary. Default is to autodetect one.
     */
    binaryPath?: string;
    /**
     * Optional list of extension IDs you intend to add. This causes ffeine to
     * automatically grant permissions to them without prompting on Firefox.
     */
    extensionIds?: string[];
    /**
     * A list of scripts that will be automatically executed on each new tab
     * for the given url matches.
     */
    injectScripts?: { matches: (string | RegExp)[]; js: string }[];
}
```
