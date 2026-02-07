# CatSwipe (GitHub Pages)

A mobile-first, Bumble-style swipe app for cat and kitten photos.

## Features

- Swipe right to like, left to pass (touch + mouse + keyboard arrows)
- Like gallery that stores your liked photos in `localStorage`
- Works as a static site (no backend) and can be published on GitHub Pages
- Pulls pictures from free APIs:
  - TheCatAPI: `https://thecatapi.com/`
  - CATAAS (Cat as a Service): `https://cataas.com/`

## Recommendation model (TensorFlow.js + MobileNet)

The app now uses a client-side vision recommender for 1 user:

- Loads MobileNet in-browser via TensorFlow.js (no server required)
- Creates normalized image embeddings for swiped photos
- Builds a centroid vector of liked photos
- Ranks incoming cards by cosine similarity to that centroid
- Combines this with lightweight metadata preferences (source, orientation, media type, tags)

Everything runs locally in the browser. No personal data leaves your device except image/API fetches.

## Tech notes

- No build pipeline is required for GitHub Pages.
- Dependencies are loaded as browser ESM from CDN:
  - `@tensorflow/tfjs`
  - `@tensorflow-models/mobilenet`
- Because this is static hosting, GitHub Actions are optional and not required for deployment.

## Run locally

Open `index.html` directly, or use a static server:

```bash
python3 -m http.server 8080
```

Then open <http://localhost:8080>.

## Deploy to GitHub Pages

After pushing to `main`, enable Pages:

1. Repo `Settings`
2. `Pages`
3. Source: `Deploy from a branch`
4. Branch: `main` and folder `/ (root)`

Your site URL will be:

`https://<your-username>.github.io/<repo-name>/`

## Notes

- Free APIs may have rate limits.
- For personal use, no backend is needed.
