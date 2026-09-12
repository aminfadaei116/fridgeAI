# Savor

A static, interactive kitchen inventory demo based on the supplied hackathon video. It is deliberately frontend-only: inventory changes live in the visitor's browser via `localStorage`, so anyone can try the full demo without a database or API keys.

## Run locally

```bash
npm run dev
```

## Deploy to Cloudflare

```bash
npm run deploy
```

On the first deploy, Wrangler will ask you to authenticate with Cloudflare. It uploads the `public/` directory as Worker static assets. The configuration uses the current Workers Static Assets format, so there is no Pages-specific setup required.

## Demo flow

1. Click **Fresh scan** to simulate the smart-fridge detection shown in the video.
2. Open **Inventory** to search, filter, add, or remove ingredients.
3. Open **Meal plan** and choose a recipe based on matching ingredients.
4. In **Kitchen settings**, reset the local demo data if needed.
