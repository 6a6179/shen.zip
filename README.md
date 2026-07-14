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

## IPA repository

The AltStore/Feather-compatible source is stored at `public/repo.json` and is
published at <https://shen.zip/repo.json>. IPA binaries stay on their upstream
release hosts; this repository serves the source metadata, icons, and
screenshots.

`.github/workflows/update-ipa-repo.yml` checks uYouEnhanced, Hop, and Flappy
Bird every six hours. When an upstream IPA changes, the updater verifies its
bundle metadata and SHA-256, updates the source, and commits the result so
Cloudflare Pages redeploys it. A weekly full verification also catches assets
that upstream maintainers replace without changing their download URL.

```sh
python3 scripts/update_ipa_repo.py
```

## Contact form

The contact form is protected by Cloudflare Turnstile and sends through the `shen-zip-contact` Worker to a private Fastmail inbox. The inbox address and Fastmail API token are stored as Worker secrets, not in the website source.

```sh
npm run check:contact
npm run deploy:contact
```

The Worker requires `FASTMAIL_API_TOKEN` and `CONTACT_TO_EMAIL` secrets.
