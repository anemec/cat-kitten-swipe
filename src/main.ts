import "../styles.css";
import * as tf from "@tensorflow/tfjs";
import * as mobilenet from "@tensorflow-models/mobilenet";
import type { CatPhoto, PreferenceWeights } from "./types";
import { applyFeedback, emptyPrefs, hybridScore } from "./lib/recommender";
import { centroidOf } from "./lib/vector";

const CAT_API_URL = "https://api.thecatapi.com/v1/images/search?limit=12";
const CATAAS_API_URL = "https://cataas.com/api/cats";
const SHIBE_API_URL = "https://shibe.online/api/cats?count=18&urls=true&httpsUrls=true";

interface MLState {
  loading: boolean;
  ready: boolean;
  error: string | null;
  model: mobilenet.MobileNet | null;
  embeddingCache: Map<string, number[]>;
  embeddingJobs: Map<string, Promise<number[] | null>>;
  likedVectors: number[][];
  likedVectorIds: Set<string>;
  centroid: number[] | null;
}

interface AppState {
  queue: CatPhoto[];
  current: CatPhoto | null;
  liked: CatPhoto[];
  seen: Set<string>;
  fetching: boolean;
  prefs: PreferenceWeights;
  ml: MLState;
}

interface Elements {
  card: HTMLElement;
  cardImage: HTMLImageElement;
  badge: HTMLElement;
  sourceText: HTMLElement;
  hintText: HTMLElement;
  queueStat: HTMLElement;
  likedStat: HTMLElement;
  mlStat: HTMLElement;
  likedGrid: HTMLElement;
  likedTemplate: HTMLTemplateElement;
  likeBtn: HTMLButtonElement;
  passBtn: HTMLButtonElement;
  clearLikesBtn: HTMLButtonElement;
}

const state: AppState = {
  queue: [],
  current: null,
  liked: loadLikes(),
  seen: new Set(),
  fetching: false,
  prefs: emptyPrefs(),
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

const el: Elements = {
  card: mustGet("card"),
  cardImage: mustGet("cardImage"),
  badge: mustGet("badge"),
  sourceText: mustGet("sourceText"),
  hintText: mustGet("hintText"),
  queueStat: mustGet("queueStat"),
  likedStat: mustGet("likedStat"),
  mlStat: mustGet("mlStat"),
  likedGrid: mustGet("likedGrid"),
  likedTemplate: mustGet("likedTemplate"),
  likeBtn: mustGet("likeBtn"),
  passBtn: mustGet("passBtn"),
  clearLikesBtn: mustGet("clearLikesBtn"),
};

let drag = {
  active: false,
  pointerId: null as number | null,
  startX: 0,
  startY: 0,
  x: 0,
  y: 0,
  startTime: 0,
  axisLocked: null as "x" | "y" | null,
};

boot().catch((err) => {
  console.error(err);
  el.hintText.textContent = "Could not load cats right now.";
});

async function boot(): Promise<void> {
  renderLiked();
  attachEvents();
  hydratePrefsFromLikes();

  void initML();
  await fillQueue();
  showNextCard();
}

function mustGet<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing required element: ${id}`);
  return node as T;
}

function attachEvents(): void {
  el.likeBtn.addEventListener("click", () => void vote(true));
  el.passBtn.addEventListener("click", () => void vote(false));

  el.clearLikesBtn.addEventListener("click", () => {
    state.liked = [];
    state.prefs = emptyPrefs();
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
  el.card.addEventListener("pointercancel", onPointerCancel);
  el.card.addEventListener("lostpointercapture", onPointerCancel);

  if (!("PointerEvent" in window)) {
    el.card.addEventListener("touchstart", onTouchStart, { passive: true });
    el.card.addEventListener("touchmove", onTouchMove, { passive: false });
    el.card.addEventListener("touchend", onTouchEnd, { passive: true });
    el.card.addEventListener("touchcancel", onTouchCancel, { passive: true });
  }

  window.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight") void vote(true);
    if (event.key === "ArrowLeft") void vote(false);
  });

  el.cardImage.addEventListener("error", onCardImageError);
}

function onCardImageError(): void {
  if (!state.current) return;

  console.warn("Skipping broken image URL", state.current.url);
  state.ml.embeddingCache.delete(state.current.unique);
  state.ml.embeddingJobs.delete(state.current.unique);
  el.hintText.textContent = "Skipped an unavailable image. Loading another cat...";
  showNextCard();
  if (state.queue.length < 10) void fillQueue();
}

function onPointerDown(event: PointerEvent): void {
  if (!event.isPrimary) return;
  startDrag(event.clientX, event.clientY, event.pointerId);
  el.card.setPointerCapture(event.pointerId);
}

function onPointerMove(event: PointerEvent): void {
  if (!drag.active || drag.pointerId !== event.pointerId) return;
  moveDrag(event.clientX, event.clientY, event.pointerType === "touch");
}

function onPointerUp(event: PointerEvent): void {
  if (!drag.active || drag.pointerId !== event.pointerId) return;
  endDrag();
}

function onPointerCancel(): void {
  cancelDrag();
}

function onTouchStart(event: TouchEvent): void {
  const t = event.touches[0];
  if (!t) return;
  startDrag(t.clientX, t.clientY, -1);
}

function onTouchMove(event: TouchEvent): void {
  if (!drag.active) return;
  const t = event.touches[0];
  if (!t) return;
  moveDrag(t.clientX, t.clientY, true);
  if (drag.axisLocked === "x") event.preventDefault();
}

function onTouchEnd(): void {
  if (!drag.active) return;
  endDrag();
}

function onTouchCancel(): void {
  cancelDrag();
}

function startDrag(clientX: number, clientY: number, pointerId: number): void {
  drag.active = true;
  drag.pointerId = pointerId;
  drag.startX = clientX;
  drag.startY = clientY;
  drag.x = 0;
  drag.y = 0;
  drag.startTime = performance.now();
  drag.axisLocked = null;
  el.card.style.transition = "none";
}

function moveDrag(clientX: number, clientY: number, isTouchLike: boolean): void {
  drag.x = clientX - drag.startX;
  drag.y = clientY - drag.startY;

  if (!drag.axisLocked && (Math.abs(drag.x) > 8 || Math.abs(drag.y) > 8)) {
    drag.axisLocked = Math.abs(drag.x) >= Math.abs(drag.y) ? "x" : "y";
  }

  if (drag.axisLocked === "y") {
    if (isTouchLike) cancelDrag();
    return;
  }

  const rotate = drag.x * 0.04;
  el.card.style.transform = `translate3d(${drag.x}px, ${drag.y * 0.12}px, 0) rotate(${rotate}deg)`;

  if (drag.x > 18) setBadge("like");
  else if (drag.x < -18) setBadge("pass");
  else setBadge("none");
}

function endDrag(): void {
  const elapsed = Math.max(1, performance.now() - drag.startTime);
  const velocityX = drag.x / elapsed;
  const threshold = Math.max(54, window.innerWidth * 0.15);
  const isFlick = Math.abs(velocityX) > 0.55 && Math.abs(drag.x) > 22;

  if (drag.x > threshold || (isFlick && velocityX > 0)) {
    animateOutAndVote(true);
  } else if (drag.x < -threshold || (isFlick && velocityX < 0)) {
    animateOutAndVote(false);
  } else {
    resetCardPosition();
  }

  drag.active = false;
  drag.pointerId = null;
  drag.axisLocked = null;
}

function cancelDrag(): void {
  drag.active = false;
  drag.pointerId = null;
  drag.axisLocked = null;
  resetCardPosition();
}

function animateOutAndVote(isLike: boolean): void {
  const x = isLike ? window.innerWidth : -window.innerWidth;
  el.card.style.transition = "transform 180ms ease";
  el.card.style.transform = `translate3d(${x}px, 0, 0) rotate(${isLike ? 24 : -24}deg)`;
  window.setTimeout(() => {
    void vote(isLike);
  }, 140);
}

function resetCardPosition(): void {
  el.card.style.transition = "transform 180ms ease";
  el.card.style.transform = "translate3d(0,0,0) rotate(0deg)";
  setBadge("none");
}

function setBadge(type: "none" | "like" | "pass"): void {
  el.badge.classList.remove("show", "like", "pass");
  if (type === "none") return;
  el.badge.classList.add("show", type);
  el.badge.textContent = type === "like" ? "Like" : "Nope";
}

async function vote(isLike: boolean): Promise<void> {
  if (!state.current) return;

  if (isLike) {
    state.liked.unshift(state.current);
    state.liked = state.liked.slice(0, 120);
    saveLikes(state.liked);
    applyFeedback(state.prefs, state.current, 1);
    renderLiked();

    if (state.ml.ready) {
      try {
        const vector = await getEmbeddingForCat(state.current);
        addLikedVector(state.current, vector);
      } catch (err) {
        console.error("Embedding update failed", err);
      }
    }
  } else {
    applyFeedback(state.prefs, state.current, -0.35);
  }

  showNextCard();
  if (state.queue.length < 10) {
    void fillQueue();
  }
}

function showNextCard(): void {
  state.current = pickNextCandidate();
  resetCardPosition();

  if (!state.current) {
    el.cardImage.removeAttribute("src");
    el.sourceText.textContent = "Source: loading...";
    el.hintText.textContent = "Pulling more cats and kittens...";
    updateStats();
    return;
  }

  const cat = state.current;
  el.cardImage.src = cat.url;
  el.cardImage.alt = `Cat photo from ${cat.source}`;
  el.sourceText.textContent = `Source: ${cat.source}${cat.tags.length ? ` | tags: ${cat.tags.slice(0, 2).join(", ")}` : ""}`;
  el.hintText.textContent = "Swipe right to like, left to pass";

  if (state.ml.ready) {
    void getEmbeddingForCat(cat);
  }

  updateStats();
}

function pickNextCandidate(): CatPhoto | null {
  if (!state.queue.length) return null;

  let bestIndex = 0;
  let bestScore = -Infinity;

  for (let index = 0; index < state.queue.length; index += 1) {
    const candidate = state.queue[index];
    const embedding = state.ml.embeddingCache.get(candidate.unique);
    const score = hybridScore({
      cat: candidate,
      prefs: state.prefs,
      centroid: state.ml.centroid,
      embedding,
    });

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }

    if (state.ml.ready && !embedding) {
      void getEmbeddingForCat(candidate);
    }
  }

  const [next] = state.queue.splice(bestIndex, 1);
  return next ?? null;
}

async function fillQueue(): Promise<void> {
  if (state.fetching) return;
  state.fetching = true;

  try {
    const fetched = await Promise.allSettled([fetchTheCatApi(), fetchCataas(), fetchShibeCats()]);
    const allCats = fetched.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    const incoming = allCats.filter((cat) => cat.url && !state.seen.has(cat.unique)).slice(0, 36);

    if (!incoming.length && fetched.every((result) => result.status === "rejected")) {
      throw new Error("All cat APIs failed");
    }

    incoming.forEach((cat) => state.seen.add(cat.unique));
    state.queue.push(...incoming);
    updateStats();

    if (state.ml.ready) warmEmbeddings(incoming, 10);
    if (!state.current) showNextCard();
  } catch (err) {
    console.error("Fetch failed", err);
    el.hintText.textContent = "API fetch failed. Check connection and try again.";
  } finally {
    state.fetching = false;
  }
}

async function fetchTheCatApi(): Promise<CatPhoto[]> {
  const response = await fetch(CAT_API_URL);
  if (!response.ok) throw new Error("TheCatAPI request failed");

  const data = (await response.json()) as Array<{
    id: string;
    url: string;
    width?: number;
    height?: number;
  }>;

  return data.map((item) => ({
    unique: `catapi:${item.id}`,
    id: item.id,
    url: item.url,
    width: item.width ?? 800,
    height: item.height ?? 800,
    tags: [],
    mime: extToMime(item.url),
    source: "TheCatAPI",
  }));
}

async function fetchCataas(): Promise<CatPhoto[]> {
  const skip = Math.floor(Math.random() * 5000);
  const url = `${CATAAS_API_URL}?limit=18&skip=${skip}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error("CATAAS request failed");

  const data = (await response.json()) as Array<{
    id: string;
    tags?: string[];
    mimetype?: string;
  }>;

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

async function fetchShibeCats(): Promise<CatPhoto[]> {
  const response = await fetch(SHIBE_API_URL);
  if (!response.ok) throw new Error("Shibe API request failed");

  const urls = (await response.json()) as string[];
  if (!Array.isArray(urls)) return [];

  return urls
    .filter((url): url is string => typeof url === "string" && url.length > 0)
    .map((url) => {
      const id = url.split("/").pop()?.split("?")[0] ?? crypto.randomUUID();
      return {
        unique: `shibe:${id}`,
        id,
        url,
        width: 800,
        height: 800,
        tags: [],
        mime: extToMime(url),
        source: "Shibe",
      };
    });
}

async function initML(): Promise<void> {
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
    void rebuildLikedVectorsFromStorage();
  } catch (err) {
    state.ml.error = String(err);
    setMLStatus("AI: unavailable");
  } finally {
    state.ml.loading = false;
  }
}

async function rebuildLikedVectorsFromStorage(): Promise<void> {
  const recent = state.liked.slice(0, 25);
  for (const cat of recent) {
    try {
      const vector = await getEmbeddingForCat(cat);
      addLikedVector(cat, vector);
    } catch {
      // Continue when some old image URLs fail.
    }
  }
}

function warmEmbeddings(cats: CatPhoto[], limit: number): void {
  cats.slice(0, limit).forEach((cat) => {
    void getEmbeddingForCat(cat);
  });
}

async function getEmbeddingForCat(cat: CatPhoto): Promise<number[] | null> {
  if (!state.ml.ready || !state.ml.model) return null;
  if (state.ml.embeddingCache.has(cat.unique)) return state.ml.embeddingCache.get(cat.unique) ?? null;
  if (state.ml.embeddingJobs.has(cat.unique)) return state.ml.embeddingJobs.get(cat.unique) ?? null;

  const job = (async () => {
    const img = await loadImage(cat.url);
    const vector = tf.tidy<number[]>(() => {
      const emb = state.ml.model!.infer(img, true);
      const tensorOut = (Array.isArray(emb) ? emb[0] : emb) as tf.Tensor;
      const squeezed = tensorOut.squeeze();
      const normalized = squeezed.div(tf.norm(squeezed));
      return Array.from(normalized.dataSync()) as number[];
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

function addLikedVector(cat: CatPhoto, vector: number[] | null): void {
  if (!vector) return;
  if (state.ml.likedVectorIds.has(cat.unique)) return;

  state.ml.likedVectorIds.add(cat.unique);
  state.ml.likedVectors.unshift(vector);
  state.ml.likedVectors = state.ml.likedVectors.slice(0, 60);
  state.ml.centroid = centroidOf(state.ml.likedVectors);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Image load failed: ${url}`));
    img.src = url;
  });
}

function extToMime(url: string): string {
  const lowered = url.toLowerCase();
  if (lowered.endsWith(".gif")) return "image/gif";
  if (lowered.endsWith(".png")) return "image/png";
  return "image/jpeg";
}

function loadLikes(): CatPhoto[] {
  try {
    const raw = localStorage.getItem("catswipe.likes");
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CatPhoto[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLikes(likes: CatPhoto[]): void {
  localStorage.setItem("catswipe.likes", JSON.stringify(likes));
}

function hydratePrefsFromLikes(): void {
  state.liked.forEach((cat) => applyFeedback(state.prefs, cat, 1));
}

function renderLiked(): void {
  el.likedGrid.innerHTML = "";

  for (const liked of state.liked.slice(0, 48)) {
    const node = el.likedTemplate.content.firstElementChild?.cloneNode(true) as HTMLElement | null;
    if (!node) continue;

    const img = node.querySelector("img");
    const caption = node.querySelector("figcaption");
    if (!img || !caption) continue;

    img.src = liked.url;
    img.alt = `Liked ${liked.source} cat`;
    caption.textContent = liked.source;

    el.likedGrid.appendChild(node);
  }

  updateStats();
}

function updateStats(): void {
  el.queueStat.textContent = `Queue: ${state.queue.length}`;
  el.likedStat.textContent = `Liked: ${state.liked.length}`;
}

function setMLStatus(text: string): void {
  el.mlStat.textContent = text;
}
