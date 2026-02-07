import "../styles.css";
import type { CatPhoto, PreferenceWeights } from "./types";
import { applyFeedback, emptyPrefs, hybridScore } from "./lib/recommender";
import { centroidOf } from "./lib/vector";

const CAT_API_URL = "https://api.thecatapi.com/v1/images/search?limit=20";
const CATAAS_API_URL = "https://cataas.com/api/cats";
const SHIBE_API_URL = "https://shibe.online/api/cats?count=24&urls=true&httpsUrls=true";
const ENABLE_EMBEDDINGS = false;
const PRELOAD_TARGET = 30;
const QUEUE_LOW_WATERMARK = 24;

type TfModule = typeof import("@tensorflow/tfjs");
type MobileNetModule = typeof import("@tensorflow-models/mobilenet");

interface MLState {
  loading: boolean;
  ready: boolean;
  error: string | null;
  tf: TfModule | null;
  mobilenet: MobileNetModule | null;
  model: Awaited<ReturnType<MobileNetModule["load"]>> | null;
  embeddingCache: Map<string, number[]>;
  embeddingJobs: Map<string, Promise<number[] | null>>;
  likedVectors: number[][];
  likedVectorIds: Set<string>;
  centroid: number[] | null;
}

interface AppState {
  queue: CatPhoto[];
  current: CatPhoto | null;
  next: CatPhoto | null;
  liked: CatPhoto[];
  seen: Set<string>;
  fetching: boolean;
  isAdvancing: boolean;
  prefs: PreferenceWeights;
  preloadedUrls: Set<string>;
  preloadJobs: Map<string, Promise<void>>;
  ml: MLState;
}

interface Elements {
  card: HTMLElement;
  cardImage: HTMLImageElement;
  badge: HTMLElement;
  sourceText: HTMLElement;
  hintText: HTMLElement;
  queueStat: HTMLElement | null;
  likedStat: HTMLElement | null;
  mlStat: HTMLElement | null;
  likedGrid: HTMLElement;
  likedTemplate: HTMLTemplateElement;
  likeBtn: HTMLButtonElement;
  passBtn: HTMLButtonElement;
  clearLikesBtn: HTMLButtonElement;
}

const state: AppState = {
  queue: [],
  current: null,
  next: null,
  liked: loadLikes(),
  seen: new Set(),
  fetching: false,
  isAdvancing: false,
  prefs: emptyPrefs(),
  preloadedUrls: new Set(),
  preloadJobs: new Map(),
  ml: {
    loading: false,
    ready: false,
    error: null,
    tf: null,
    mobilenet: null,
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
  queueStat: document.getElementById("queueStat"),
  likedStat: document.getElementById("likedStat"),
  mlStat: document.getElementById("mlStat"),
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

  if (ENABLE_EMBEDDINGS) {
    void initML();
  }
  await fillQueue();
  ensureDeckPrimed();
}

function mustGet<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing required element: ${id}`);
  return node as T;
}

function attachEvents(): void {
  el.likeBtn.addEventListener("click", () => triggerVote(true));
  el.passBtn.addEventListener("click", () => triggerVote(false));

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
    if (event.key === "ArrowRight") triggerVote(true);
    if (event.key === "ArrowLeft") triggerVote(false);
  });

  el.cardImage.addEventListener("error", onCardImageError);
}

function onCardImageError(): void {
  if (!state.current) return;

  state.isAdvancing = false;
  console.warn("Skipping broken image URL", state.current.url);
  state.ml.embeddingCache.delete(state.current.unique);
  state.ml.embeddingJobs.delete(state.current.unique);
  state.preloadedUrls.delete(state.current.url);
  state.preloadJobs.delete(state.current.url);
  el.hintText.textContent = "Skipped an unavailable image. Loading another cat...";
  shiftDeck();
  renderDeck();
  if (state.queue.length < QUEUE_LOW_WATERMARK) void fillQueue();
}

function onPointerDown(event: PointerEvent): void {
  if (state.isAdvancing) return;
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
    triggerVote(true);
  } else if (drag.x < -threshold || (isFlick && velocityX < 0)) {
    triggerVote(false);
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

function triggerVote(isLike: boolean): void {
  if (state.isAdvancing || !state.current) return;
  state.isAdvancing = true;
  void animateOutAndVote(isLike);
}

async function animateOutAndVote(isLike: boolean): Promise<void> {
  const direction = isLike ? 1 : -1;
  const x = direction * (window.innerWidth + 80);
  el.card.style.transition = "transform 230ms cubic-bezier(0.2, 0.82, 0.35, 1), opacity 210ms ease";
  el.card.style.opacity = "0.92";
  el.card.style.transform = `translate3d(${x}px, 0, 0) rotate(${direction * 24}deg)`;
  await waitForTransition(el.card, 260);
  await vote(isLike, { skipReset: true });
  await animateCardIn(direction);
}

async function animateCardIn(direction: number): Promise<void> {
  el.card.style.transition = "none";
  el.card.style.opacity = "0.08";
  el.card.style.transform = `translate3d(${direction * 38}px, 10px, 0) scale(0.982)`;
  setBadge("none");

  await nextFrame();
  await nextFrame();

  el.card.style.transition = "transform 280ms cubic-bezier(0.22, 1, 0.36, 1), opacity 230ms ease";
  el.card.style.opacity = "1";
  el.card.style.transform = "translate3d(0,0,0) rotate(0deg) scale(1)";
  await waitForTransition(el.card, 320);
  state.isAdvancing = false;
}

function resetCardPosition(): void {
  el.card.style.transition = "transform 180ms ease, opacity 150ms ease";
  el.card.style.opacity = "1";
  el.card.style.transform = "translate3d(0,0,0) rotate(0deg) scale(1)";
  setBadge("none");
}

function setBadge(type: "none" | "like" | "pass"): void {
  el.badge.classList.remove("show", "like", "pass");
  if (type === "none") return;
  el.badge.classList.add("show", type);
  el.badge.textContent = type === "like" ? "🐾🐾" : "🐾";
}

async function vote(isLike: boolean, options: { skipReset?: boolean } = {}): Promise<void> {
  if (!state.current) {
    state.isAdvancing = false;
    return;
  }

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

  shiftDeck();
  renderDeck({ skipReset: options.skipReset ?? false });
  if (state.queue.length < QUEUE_LOW_WATERMARK) {
    void fillQueue();
  }
}

function ensureDeckPrimed(): void {
  if (!state.current) {
    shiftDeck();
    renderDeck();
    return;
  }

  if (!state.next) {
    state.next = pickNextCandidate();
  }

  preloadUpcomingImages(PRELOAD_TARGET);
  updateStats();
}

function shiftDeck(): void {
  state.current = state.next ?? pickNextCandidate();
  state.next = pickNextCandidate();
}

function renderDeck(options: { skipReset?: boolean } = {}): void {
  if (!options.skipReset) resetCardPosition();

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
  el.hintText.textContent = "Swipe right 🐾🐾, left 🐾";

  if (state.ml.ready) {
    void getEmbeddingForCat(cat);
  }

  preloadUpcomingImages(PRELOAD_TARGET);
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
    const incoming = allCats.filter((cat) => cat.url && !state.seen.has(cat.unique)).slice(0, 60);

    if (!incoming.length && fetched.every((result) => result.status === "rejected")) {
      throw new Error("All cat APIs failed");
    }

    incoming.forEach((cat) => state.seen.add(cat.unique));
    state.queue.push(...incoming);
    updateStats();

    if (state.ml.ready) warmEmbeddings(incoming, 16);
    preloadUpcomingImages(PRELOAD_TARGET);
    ensureDeckPrimed();
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
  const url = `${CATAAS_API_URL}?limit=24&skip=${skip}`;
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
  if (!ENABLE_EMBEDDINGS) {
    setMLStatus("");
    return;
  }
  if (state.ml.loading || state.ml.ready) return;
  state.ml.loading = true;
  setMLStatus("AI: loading MobileNet...");

  try {
    if (!state.ml.tf || !state.ml.mobilenet) {
      const [tf, mobilenet] = await Promise.all([
        import("@tensorflow/tfjs"),
        import("@tensorflow-models/mobilenet"),
      ]);
      state.ml.tf = tf;
      state.ml.mobilenet = mobilenet;
    }

    const tf = state.ml.tf;
    const mobilenet = state.ml.mobilenet;
    if (!tf || !mobilenet) throw new Error("ML dependencies failed to load");

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

function preloadUpcomingImages(limit: number): void {
  const candidates: CatPhoto[] = [];
  if (state.current) candidates.push(state.current);
  if (state.next) candidates.push(state.next);
  candidates.push(...state.queue.slice(0, limit));

  candidates.forEach((cat) => {
    void preloadImage(cat.url);
  });
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function waitForTransition(node: HTMLElement, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      node.removeEventListener("transitionend", onEnd);
      resolve();
    };
    const onEnd = (event: TransitionEvent): void => {
      if (event.target === node) done();
    };
    node.addEventListener("transitionend", onEnd);
    window.setTimeout(done, timeoutMs);
  });
}

function preloadImage(url: string): Promise<void> {
  if (state.preloadedUrls.has(url)) return Promise.resolve();
  if (state.preloadJobs.has(url)) return state.preloadJobs.get(url) ?? Promise.resolve();

  const job = new Promise<void>((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      state.preloadedUrls.add(url);
      resolve();
    };
    img.onerror = () => resolve();
    img.src = url;
  }).finally(() => {
    state.preloadJobs.delete(url);
  });

  state.preloadJobs.set(url, job);
  return job;
}

async function getEmbeddingForCat(cat: CatPhoto): Promise<number[] | null> {
  if (!ENABLE_EMBEDDINGS || !state.ml.ready || !state.ml.model || !state.ml.tf) return null;
  if (state.ml.embeddingCache.has(cat.unique)) return state.ml.embeddingCache.get(cat.unique) ?? null;
  if (state.ml.embeddingJobs.has(cat.unique)) return state.ml.embeddingJobs.get(cat.unique) ?? null;

  const tf = state.ml.tf;
  const job = (async () => {
    const img = await loadImage(cat.url);
    const vector = tf.tidy<number[]>(() => {
      const emb = state.ml.model!.infer(img, true);
      const tensorOut = (Array.isArray(emb) ? emb[0] : emb) as import("@tensorflow/tfjs").Tensor;
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
  if (el.queueStat) el.queueStat.textContent = `Queue: ${state.queue.length}`;
  if (el.likedStat) el.likedStat.textContent = `Liked: ${state.liked.length}`;
}

function setMLStatus(text: string): void {
  if (el.mlStat) el.mlStat.textContent = text;
}
