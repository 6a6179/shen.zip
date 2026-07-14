# shen.zip

A personal bio site and notes archive built with Astro, Tailwind CSS, and shadcn/ui components. It deploys to Cloudflare Pages.

## Commands

```sh
npm install
npm run dev
npm run check
npm run build
```

Pushing `main` deploys the site through Cloudflare Pages.

## Contact form

The contact form is protected by Cloudflare Turnstile and sends through the `shen-zip-contact` Worker to a private Fastmail inbox. The inbox address and Fastmail API token are stored as Worker secrets, not in the website source.

```sh
npm run check:contact
npm run deploy:contact
```

The Worker requires `FASTMAIL_API_TOKEN` and `CONTACT_TO_EMAIL` secrets.
