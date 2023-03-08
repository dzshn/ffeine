# ffeine

A tiny alternative to `web-ext run`, for usage in build scripts.

```typescript
import { Firefox } from "ffeine";

async function main() {
    const browser = new Firefox({ url: "example.com" });
    const extension = await browser.installExtension("dist/extension.zip");

    // later
    await browser.reloadExtension(extension);
}
```
