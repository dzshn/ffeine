# ffeine

```typescript
import { Firefox } from "ffeine";

async function main() {
    const browser = new Firefox({ url: "example.com" });
		const extension = await browser.installExtension("dist/extension.zip");

    // later
		await browser.reloadExtension(extension);
}
```
