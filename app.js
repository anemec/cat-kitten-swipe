import * as tf from "https://esm.sh/@tensorflow/tfjs@4.22.0";
import * as mobilenet from "https://esm.sh/@tensorflow-models/mobilenet@2.1.1";

const CAT_API_URL = "https://api.thecatapi.com/v1/images/search?limit=12";
const CATAAS_API_URL = "https://cataas.com/api/cats";

const state = {
  queue: [],
  current: null,
  liked: loadLikes(),
  seen: new Set(),
  fetching: false,
  prefs: {
    tags: {},
    source: {},
    orientation: {},
    media: {},
  },
  ml: {
    loading: false,
    ready: false,
    error: null,
    model: null,
    embeddingCache: new Map(),
    embeddingJobs: new Map(),
    likedVectors: [],
    likedVectorIds: new Set(),
    centroid: null,
  },
};

const el = {
  card: document.getElementById("card"),
  cardImage: document.getElementById("cardImage"),
  badge: document.getElementById("badge"),
  sourceText: document.getElementById("sourceText"),
  hintText: document.getElementById("hintText"),
  queueStat: document.getElementById("queueStat"),
  likedStat: document.getElementById("likedStat"),
  mlStat: document.getElementById("mlStat"),
  likedGrid: document.getElementById("likedGrid"),
  likedTemplate: document.getElementById("likedTemplate"),
  likeBtn: document.getElementById("likeBtn"),
  passBtn: document.getElementById("passBtn"),
  clearLikesBtn: document.getElementById("clearLikesBtn"),
};

let drag = {
  active: false,
  startX: 0,
  startY: 0,
  x: 0,
  y: 0,
};

boot().catch((err) => {
  console.error(err);
  el.hintText.textContent = "Could not load cats right now.";
});

async function boot() {
  renderLiked();
  attachEvents();
  hydratePrefsFromLikes();

  initML().catch((err) => {
    console.error("ML init failed", err);
  });

  await fillQueue();
  showNextCard();
}

function attachEvents() {
  el.likeBtn.addEventListener("click", () => vote(true));
  el.passBtn.addEventListener("click", () => vote(false));

  el.clearLikesBtn.addEventListener("click", () => {
    state.liked = [];
    state.prefs = { tags: {}, source: {}, orientation: {}, media: {} };
    state.ml.likedVectors = [];
    state.ml.likedVectorIds = new Set();
    state.ml.centroid = null;
    saveLikes(state.liked);
    renderLiked();
    updateStats();
  });

  el.card.addEventListener("pointerdown", onPointerDown);
  el.card.addEventListener("pointermove", onPointerMove);
  el.card.addEventListener("pointerup", onPointerUp);
  el.card.addEventListener("pointercancel", resetDrag);
  el.card.addEventListener("lostpointercapture", resetDrag);

  window.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") vote(true);
    if (e.key === "ArrowLeft") vote(false);
  });
}

function onPointerDown(e) {
  drag.active = true;
  drag.startX = e.clientX;
  drag.startY = e.clientY;
  drag.x = 0;
  drag.y = 0;
  el.card.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
  if (!drag.active) return;
  drag.x = e.clientX - drag.startX;
  drag.y = e.clientY - drag.startY;
  const rotate = drag.x * 0.04;
  el.card.style.transform = `translate3d(${drag.x}px, ${drag.y * 0.15}px, 0) rotate(${rotate}deg)`;

  if (drag.x > 22) setBadge("like");
  else if (drag.x < -22) setBadge("pass");
  else setBadge("none");
}

function onPointerUp() {
  if (!drag.active) return;
  const threshold = Math.max(72, window.innerWidth * 0.18);
  if (drag.x > threshold) {
    animateOutAndVote(true);
  } else if (drag.x < -threshold) {
    animateOutAndVote(false);
  } else {
    resetCardPosition();
  }
  drag.active = false;
}

function resetDrag() {
  drag.active = false;
  resetCardPosition();
}

function animateOutAndVote(isLike) {
  const x = isLike ? window.innerWidth : -window.innerWidth;
  el.card.style.transition = "transform 180ms ease";
  el.card.style.transform = `translate3d(${x}px, 0, 0) rotate(${isLike ? 24 : -24}deg)`;
  setTimeout(() => vote(isLike), 140);
}

function resetCardPosition() {
  el.card.style.transition = "transform 180ms ease";
  el.card.style.transform = "translate3d(0,0,0) rotate(0deg)";
  setBadge("none");
}

function setBadge(type) {
  el.badge.classList.remove("show", "like", "pass");
  if (type === "none") return;
  el.badge.classList.add("show", type);
  el.badge.textContent = type === "like" ? "Like" : "Nope";
}

async function vote(isLike) {
  if (!state.current) return;

  if (isLike) {
    state.liked.unshift(state.current);
    state.liked = state.liked.slice(0, 120);
    saveLikes(state.liked);
    applyFeedback(state.current, 1);
    renderLiked();
    if (state.ml.ready) {
      getEmbeddingForCat(state.current)
        .then((vector) => addLikedVector(state.current, vector))
        .catch((err) => console.error("Embedding update failed", err));
    }
  } else {
    applyFeedback(state.current, -0.35);
  }

  showNextCard();
  if (state.queue.length < 10) {
    fillQueue();
  }
}

function showNextCard() {
  state.current = pickNextCandidate();
  resetCardPosition();

  if (!state.current) {
    el.cardImage.removeAttribute("src");
    el.sourceText.textContent = "Source: loading...";
    el.hintText.textContent = "Pulling more cats and kittens...";
    updateStats();
    return;
  }

  const c = state.current;
  el.cardImage.crossOrigin = "anonymous";
  el.cardImage.src = c.url;
  el.cardImage.alt = `Cat photo from ${c.source}`;
  el.sourceText.textContent = `Source: ${c.source}${c.tags.length ? ` | tags: ${c.tags.slice(0, 2).join(", ")}` : ""}`;
  el.hintText.textContent = "Swipe right to like, left to pass";

  if (state.ml.ready) {
    getEmbeddingForCat(c).catch(() => {});
  }

  updateStats();
}

function pickNextCandidate() {
  if (!state.queue.length) return null;

  let bestIndex = 0;
  let bestScore = -Infinity;

  for (let i = 0; i < state.queue.length; i += 1) {
    const score = predictLikeScore(state.queue[i]);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  const [candidate] = state.queue.splice(bestIndex, 1);
  return candidate;
}

function predictLikeScore(cat) {
  const features = extractFeatures(cat);
  let score = Math.random() * 0.2;

  for (const t of features.tags) score += (state.prefs.tags[t] || 0) * 0.45;
  score += (state.prefs.source[features.source] || 0) * 0.25;
  score += (state.prefs.orientation[features.orientation] || 0) * 0.22;
  score += (state.prefs.media[features.media] || 0) * 0.15;

  if (state.ml.ready && state.ml.centroid) {
    const vector = state.ml.embeddingCache.get(cat.unique);
    if (vector) {
      score += cosine(vector, state.ml.centroid) * 2.2;
    } else {
      score += 0.06;
      getEmbeddingForCat(cat).catch(() => {});
    }
  }

  return score;
}

function applyFeedback(cat, delta) {
  const features = extractFeatures(cat);
  for (const t of features.tags) state.prefs.tags[t] = (state.prefs.tags[t] || 0) + delta;
  state.prefs.source[features.source] = (state.prefs.source[features.source] || 0) + delta;
  state.prefs.orientation[features.orientation] = (state.prefs.orientation[features.orientation] || 0) + delta * 0.7;
  state.prefs.media[features.media] = (state.prefs.media[features.media] || 0) + delta * 0.5;
}

function extractFeatures(cat) {
  const orientation = cat.width > cat.height ? "landscape" : cat.width < cat.height ? "portrait" : "square";
  const media = cat.mime.includes("gif") ? "gif" : "photo";

  return {
    tags: cat.tags.map((t) => t.toLowerCase()).slice(0, 8),
    source: cat.source,
    orientation,
    media,
  };
}

async function fillQueue() {
  if (state.fetching) return;
  state.fetching = true;

  try {
    const [catApi, cataas] = await Promise.all([fetchTheCatApi(), fetchCataas()]);
    const incoming = [...catApi, ...cataas]
      .filter((c) => c.url && !state.seen.has(c.unique))
      .slice(0, 36);

    incoming.forEach((c) => state.seen.add(c.unique));
    state.queue.push(...incoming);
    updateStats();

    if (state.ml.ready) {
      warmEmbeddings(incoming, 10);
    }

    if (!state.current) showNextCard();
  } catch (e) {
    console.error("Fetch failed", e);
    el.hintText.textContent = "API fetch failed. Check connection and try again.";
  } finally {
    state.fetching = false;
  }
}

async function fetchTheCatApi() {
  const res = await fetch(CAT_API_URL);
  if (!res.ok) throw new Error("TheCatAPI request failed");
  const data = await res.json();

  return data.map((item) => ({
    unique: `catapi:${item.id}`,
    id: item.id,
    url: item.url,
    width: item.width || 800,
    height: item.height || 800,
    tags: [],
    mime: extToMime(item.url),
    source: "TheCatAPI",
  }));
}

async function fetchCataas() {
  const skip = Math.floor(Math.random() * 5000);
  const url = `${CATAAS_API_URL}?limit=18&skip=${skip}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("CATAAS request failed");
  const data = await res.json();

  return data.map((item) => ({
    unique: `cataas:${item.id}`,
    id: item.id,
    url: `https://cataas.com/cat/${item.id}`,
    width: 800,
    height: 1000,
    tags: Array.isArray(item.tags) ? item.tags : [],
    mime: item.mimetype || "image/jpeg",
    source: "CATAAS",
  }));
}

async function initML() {
  if (state.ml.loading || state.ml.ready) return;
  state.ml.loading = true;
  setMLStatus("AI: loading MobileNet...");

  try {
    try {
      await tf.setBackend("webgl");
    } catch {
      await tf.setBackend("cpu");
    }

    await tf.ready();
    state.ml.model = await mobilenet.load({ version: 2, alpha: 1.0 });
    state.ml.ready = true;
    setMLStatus(`AI: ready (${tf.getBackend()})`);

    warmEmbeddings(state.queue, 10);
    rebuildLikedVectorsFromStorage();
  } catch (err) {
    state.ml.error = String(err);
    setMLStatus("AI: unavailable");
  } finally {
    state.ml.loading = false;
  }
}

async function rebuildLikedVectorsFromStorage() {
  const recent = state.liked.slice(0, 25);
  for (const cat of recent) {
    try {
      const vector = await getEmbeddingForCat(cat);
      addLikedVector(cat, vector);
    } catch {
      // Continue if some old images are no longer reachable.
    }
  }
}

function warmEmbeddings(cats, limit) {
  const batch = cats.slice(0, limit);
  batch.forEach((cat) => {
    getEmbeddingForCat(cat).catch(() => {});
  });
}

async function getEmbeddingForCat(cat) {
  if (!state.ml.ready || !state.ml.model) return null;
  if (state.ml.embeddingCache.has(cat.unique)) return state.ml.embeddingCache.get(cat.unique);
  if (state.ml.embeddingJobs.has(cat.unique)) return state.ml.embeddingJobs.get(cat.unique);

  const job = (async () => {
    const img = await loadImage(cat.url);
    const vector = tf.tidy(() => {
      const emb = state.ml.model.infer(img, true);
      const tensorOut = Array.isArray(emb) ? emb[0] : emb;
      const tensor = tensorOut.squeeze();
      const normalized = tensor.div(tf.norm(tensor));
      return Array.from(normalized.dataSync());
    });

    state.ml.embeddingCache.set(cat.unique, vector);
    return vector;
  })();

  state.ml.embeddingJobs.set(cat.unique, job);

  try {
    return await job;
  } finally {
    state.ml.embeddingJobs.delete(cat.unique);
  }
}

function addLikedVector(cat, vector) {
  if (!vector) return;
  if (state.ml.likedVectorIds.has(cat.unique)) return;

  state.ml.likedVectorIds.add(cat.unique);
  state.ml.likedVectors.unshift(vector);
  state.ml.likedVectors = state.ml.likedVectors.slice(0, 60);
  recomputeCentroid();
}

function recomputeCentroid() {
  if (!state.ml.likedVectors.length) {
    state.ml.centroid = null;
    return;
  }

  const size = state.ml.likedVectors[0].length;
  const sum = new Array(size).fill(0);

  for (const vec of state.ml.likedVectors) {
    for (let i = 0; i < size; i += 1) sum[i] += vec[i];
  }

  for (let i = 0; i < size; i += 1) sum[i] /= state.ml.likedVectors.length;
  state.ml.centroid = normalize(sum);
}

function normalize(v) {
  const mag = Math.sqrt(v.reduce((acc, n) => acc + n * n, 0)) || 1;
  return v.map((n) => n / mag);
}

function cosine(a, b) {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) dot += a[i] * b[i];
  return dot;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Image load failed: ${url}`));
    img.src = url;
  });
}

function extToMime(url) {
  if (!url) return "image/jpeg";
  const lowered = url.toLowerCase();
  if (lowered.endsWith(".gif")) return "image/gif";
  if (lowered.endsWith(".png")) return "image/png";
  return "image/jpeg";
}

function loadLikes() {
  try {
    const raw = localStorage.getItem("catswipe.likes");
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveLikes(likes) {
  localStorage.setItem("catswipe.likes", JSON.stringify(likes));
}

function hydratePrefsFromLikes() {
  state.liked.forEach((cat) => applyFeedback(cat, 1));
}

function renderLiked() {
  el.likedGrid.innerHTML = "";

  for (const liked of state.liked.slice(0, 48)) {
    const node = el.likedTemplate.content.firstElementChild.cloneNode(true);
    const img = node.querySelector("img");
    const caption = node.querySelector("figcaption");

    img.src = liked.url;
    img.alt = `Liked ${liked.source} cat`;
    caption.textContent = liked.source;

    el.likedGrid.appendChild(node);
  }

  updateStats();
}

function updateStats() {
  el.queueStat.textContent = `Queue: ${state.queue.length}`;
  el.likedStat.textContent = `Liked: ${state.liked.length}`;
}

function setMLStatus(text) {
  if (el.mlStat) el.mlStat.textContent = text;
}
