# mypiano-bog-payment

Render Node.js/Express server for MyPiano.ge BOG direct checkout.

## Render commands

Build command:
```bash
npm install
```

Start command:
```bash
npm start
```

## Required environment variables

- BOG_CLIENT_ID
- BOG_CLIENT_SECRET
- APP_URL
- SHOPIFY_SHOP
- SHOPIFY_CLIENT_ID
- SHOPIFY_CLIENT_SECRET

## Accounting separation

BOG external_order_id prefix:
```text
MP-
```

So MyPiano payments can be separated from FitStore payments.
