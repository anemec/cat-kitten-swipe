# CatSwipe (GitHub Pages)

A mobile-first, Bumble-style swipe app for cat and kitten photos.

## Features

- Swipe right to like, left to pass (touch + mouse + keyboard arrows)
- Like gallery that stores your liked photos in `localStorage`
- Works as a static site (no backend) and can be published on GitHub Pages
- Pulls pictures from free APIs:
  - TheCatAPI: `https://thecatapi.com/`
  - CATAAS (Cat as a Service): `https://cataas.com/`

## Basic recommendation algorithm (included)

The app includes a lightweight 1-user recommender:

- It tracks features from liked photos:
  - source (`TheCatAPI` vs `CATAAS`)
  - orientation (`portrait`, `landscape`, `square`)
  - media type (`gif` vs still image)
  - tags (from CATAAS metadata)
- Each new card gets a score from those learned preferences.
- Highest score is shown next, so liked patterns are prioritized over time.

This is intentionally simple, private, and runs fully in-browser.

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
- If you want stronger recommendations later, you can add image embeddings (e.g. with TensorFlow.js + MobileNet) and nearest-neighbor scoring.
