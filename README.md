# CatSwipe (TypeScript + MobileNet)

A mobile-first, Bumble-style swipe app for cat and kitten photos.

## Stack

- TypeScript + Vite
- TensorFlow.js + MobileNet embeddings (client-side)
- Vitest unit tests for recommendation logic
- GitHub Actions workflow for typecheck, tests, build, and Pages deploy

## Features

- Swipe right to like, left to pass (touch + mouse + keyboard arrows)
- Like gallery persisted in `localStorage`
- Free image sources:
  - TheCatAPI: `https://thecatapi.com/`
  - CATAAS: `https://cataas.com/`
- 1-user recommender:
  - metadata scoring (tags/source/orientation/media)
  - embedding similarity scoring with MobileNet + cosine similarity

## Development

```bash
npm install
npm run dev
```

## Quality checks

```bash
npm run typecheck
npm test
npm run build
```

## Deployment

- Build output goes to `docs/`.
- `.github/workflows/pages.yml` runs tests + build and deploys to GitHub Pages on `main`.

## Notes

- This is personal-use, fully static hosting (no backend).
- Free APIs may impose rate limits.
