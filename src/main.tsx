import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { motion } from "framer-motion";
import type { CatPhoto } from "./types";
import "./app.css";

const CAT_API_URL = "https://api.thecatapi.com/v1/images/search?limit=24";
const CATAAS_API_URL = "https://cataas.com/api/cats";
const SHIBE_API_URL = "https://shibe.online/api/cats?count=28&urls=true&httpsUrls=true";

const PRELOAD_TARGET = 20;
const QUEUE_LOW_WATERMARK = 20;
const INCOMING_CAP = 90;
const SWIPE_FALLBACK_MS = 460;

function loadLiked(): CatPhoto[] {
  try {
    const raw = localStorage.getItem("catswipe.likes");
    const parsed = raw ? (JSON.parse(raw) as CatPhoto[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLiked(items: CatPhoto[]): void {
  localStorage.setItem("catswipe.likes", JSON.stringify(items));
}

function extToMime(url: string): string {
  const lower = url.toLowerCase();
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".png")) return "image/png";
  return "image/jpeg";
}

async function fetchTheCatApi(): Promise<CatPhoto[]> {
  const response = await fetch(CAT_API_URL);
  if (!response.ok) throw new Error("TheCatAPI request failed");
  const data = (await response.json()) as Array<{ id: string; url: string; width?: number; height?: number }>;

  return data.map((item) => ({
    unique: `catapi:${item.id}`,
    id: item.id,
    url: item.url,
    width: item.width ?? 900,
    height: item.height ?? 900,
    tags: [],
    mime: extToMime(item.url),
    source: "TheCatAPI",
  }));
}

async function fetchCataas(): Promise<CatPhoto[]> {
  const skip = Math.floor(Math.random() * 7000);
  const response = await fetch(`${CATAAS_API_URL}?limit=30&skip=${skip}`);
  if (!response.ok) throw new Error("CATAAS request failed");
  const data = (await response.json()) as Array<{ id: string; tags?: string[]; mimetype?: string }>;

  return data.map((item) => ({
    unique: `cataas:${item.id}`,
    id: item.id,
    url: `https://cataas.com/cat/${item.id}`,
    width: 900,
    height: 1100,
    tags: Array.isArray(item.tags) ? item.tags : [],
    mime: item.mimetype || "image/jpeg",
    source: "CATAAS",
  }));
}

async function fetchShibe(): Promise<CatPhoto[]> {
  const response = await fetch(SHIBE_API_URL);
  if (!response.ok) throw new Error("Shibe request failed");
  const urls = (await response.json()) as string[];
  if (!Array.isArray(urls)) return [];

  return urls
    .filter((url): url is string => typeof url === "string" && url.length > 0)
    .map((url) => {
      const id = url.split("/").pop()?.split("?")[0] ?? `shibe-${Math.random().toString(36).slice(2)}`;
      return {
        unique: `shibe:${id}`,
        id,
        url,
        width: 900,
        height: 900,
        tags: [],
        mime: extToMime(url),
        source: "Shibe",
      };
    });
}

type SwipeDir = "left" | "right";

function App(): JSX.Element {
  const [cards, setCards] = useState<CatPhoto[]>([]);
  const [liked, setLiked] = useState<CatPhoto[]>(() => loadLiked());
  const [fetchError, setFetchError] = useState("");
  const [isFetching, setIsFetching] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [swiping, setSwiping] = useState<{ unique: string; dir: SwipeDir } | null>(null);

  const seenRef = useRef<Set<string>>(new Set(liked.map((card) => card.unique)));
  const preloadedRef = useRef<Set<string>>(new Set());
  const preloadJobsRef = useRef<Map<string, Promise<void>>>(new Map());
  const fetchingRef = useRef(false);
  const swipeTimeoutRef = useRef<number | null>(null);

  const swipeThreshold = useMemo(() => {
    if (typeof window === "undefined") return 100;
    return Math.max(95, Math.floor(window.innerWidth * 0.22));
  }, []);

  const preloadImage = useCallback((url: string): Promise<void> => {
    if (preloadedRef.current.has(url)) return Promise.resolve();
    const existing = preloadJobsRef.current.get(url);
    if (existing) return existing;

    const job = new Promise<void>((resolve) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => {
        preloadedRef.current.add(url);
        resolve();
      };
      img.onerror = () => resolve();
      img.src = url;
    }).finally(() => preloadJobsRef.current.delete(url));

    preloadJobsRef.current.set(url, job);
    return job;
  }, []);

  const preloadFromStack = useCallback(
    (stack: CatPhoto[]) => {
      for (const card of stack.slice(-PRELOAD_TARGET)) {
        void preloadImage(card.url);
      }
    },
    [preloadImage],
  );

  const fillQueue = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    setIsFetching(true);

    try {
      const results = await Promise.allSettled([fetchTheCatApi(), fetchCataas(), fetchShibe()]);
      const fetched = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
      const incoming = fetched.filter((item) => item.url && !seenRef.current.has(item.unique)).slice(0, INCOMING_CAP);

      if (!incoming.length && results.every((r) => r.status === "rejected")) {
        throw new Error("All APIs failed");
      }

      incoming.forEach((item) => seenRef.current.add(item.unique));
      setCards((prev) => {
        const next = [...incoming, ...prev];
        preloadFromStack(next);
        return next;
      });
      setFetchError("");
    } catch (err) {
      console.error(err);
      setFetchError("Could not load more photos right now.");
    } finally {
      setIsFetching(false);
      fetchingRef.current = false;
    }
  }, [preloadFromStack]);

  useEffect(() => {
    if (!cards.length) void fillQueue();
  }, [cards.length, fillQueue]);

  useEffect(() => {
    if (!initialLoading || cards.length === 0) return;
    const timer = window.setTimeout(() => setInitialLoading(false), 420);
    return () => window.clearTimeout(timer);
  }, [cards.length, initialLoading]);

  useEffect(() => {
    preloadFromStack(cards);
  }, [cards, preloadFromStack]);

  useEffect(() => {
    if (swiping && !cards.some((card) => card.unique === swiping.unique)) {
      setSwiping(null);
    }
  }, [cards, swiping]);

  const removeCard = useCallback(
    (unique: string) => {
      setCards((prev) => {
        const next = prev.filter((card) => card.unique !== unique);
        if (next.length < QUEUE_LOW_WATERMARK) void fillQueue();
        return next;
      });
    },
    [fillQueue],
  );

  useEffect(() => {
    if (!swiping) return;

    if (swipeTimeoutRef.current) window.clearTimeout(swipeTimeoutRef.current);
    swipeTimeoutRef.current = window.setTimeout(() => {
      removeCard(swiping.unique);
      setSwiping(null);
      swipeTimeoutRef.current = null;
    }, SWIPE_FALLBACK_MS);

    return () => {
      if (swipeTimeoutRef.current) {
        window.clearTimeout(swipeTimeoutRef.current);
        swipeTimeoutRef.current = null;
      }
    };
  }, [removeCard, swiping]);

  const likeCard = useCallback((card: CatPhoto) => {
    setLiked((prev) => {
      const next = [card, ...prev.filter((item) => item.unique !== card.unique)].slice(0, 160);
      saveLiked(next);
      return next;
    });
  }, []);

  const commitSwipe = useCallback(
    (dir: SwipeDir) => {
      const top = cards[cards.length - 1];
      if (!top || swiping) return;
      setSwiping({ unique: top.unique, dir });
      if (dir === "right") likeCard(top);
    },
    [cards, likeCard, swiping],
  );

  const onTopDragEnd = useCallback(
    (_: PointerEvent | MouseEvent | TouchEvent, info: { offset: { x: number }; velocity: { x: number } }) => {
      if (swiping) return;
      const x = info.offset.x;
      const vx = info.velocity.x;
      if (x > swipeThreshold || vx > 650) {
        commitSwipe("right");
        return;
      }
      if (x < -swipeThreshold || vx < -650) {
        commitSwipe("left");
      }
    },
    [commitSwipe, swipeThreshold, swiping],
  );

  const displayed = cards.slice(-4);

  return (
    <main className="scene">
      {initialLoading ? (
        <motion.div
          className="initialLoader"
          initial={{ opacity: 1 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.35, ease: "easeOut" }}
        >
          <div className="loaderInner">
            <h2>Warming The Cat Bus</h2>
            <p>Gathering kittens from the sky...</p>
            <div className="loaderPaws" aria-hidden="true">
              <motion.span animate={{ y: [0, -10, 0] }} transition={{ duration: 0.9, repeat: Infinity, ease: "easeInOut" }}>🐾</motion.span>
              <motion.span animate={{ y: [0, -10, 0] }} transition={{ duration: 0.9, repeat: Infinity, ease: "easeInOut", delay: 0.15 }}>🐾</motion.span>
              <motion.span animate={{ y: [0, -10, 0] }} transition={{ duration: 0.9, repeat: Infinity, ease: "easeInOut", delay: 0.3 }}>🐾</motion.span>
            </div>
          </div>
        </motion.div>
      ) : null}

      <motion.div className="atmo a" animate={{ y: [-10, 10, -10], x: [-8, 10, -8] }} transition={{ repeat: Infinity, duration: 16, ease: "easeInOut" }} />
      <motion.div className="atmo b" animate={{ y: [8, -12, 8], x: [6, -8, 6] }} transition={{ repeat: Infinity, duration: 18, ease: "easeInOut" }} />

      <header className="hero">
        <h1>CatSwipe</h1>
      </header>

      <section className="deckWrap">
        <div className="deck">
          {cards.length === 0 && <div className="emptyCard">{isFetching ? "Finding cats and kittens..." : "No cats loaded yet."}</div>}

          {displayed.map((card, index) => {
            const depth = displayed.length - 1 - index;
            const isTop = depth === 0;
            const isActiveSwipe = swiping?.unique === card.unique;

            return (
              <motion.article
                key={card.unique}
                className={`card ${isTop ? "top" : ""}`}
                drag={isTop && !swiping ? "x" : false}
                dragElastic={0.18}
                dragMomentum
                onDragEnd={isTop ? onTopDragEnd : undefined}
                style={{ zIndex: index + 1 }}
                initial={false}
                animate={
                  isActiveSwipe
                    ? {
                        x: swiping?.dir === "right" ? window.innerWidth * 1.15 : -window.innerWidth * 1.15,
                        rotate: swiping?.dir === "right" ? 24 : -24,
                        opacity: 0.2,
                        scale: 0.97,
                      }
                    : {
                        x: 0,
                        y: depth * 8,
                        rotate: 0,
                        opacity: 1 - depth * 0.11,
                        scale: 1 - depth * 0.024,
                      }
                }
                transition={{ type: "spring", stiffness: 460, damping: 34, mass: 0.72 }}
                onAnimationComplete={() => {
                  if (isActiveSwipe) {
                    if (swipeTimeoutRef.current) {
                      window.clearTimeout(swipeTimeoutRef.current);
                      swipeTimeoutRef.current = null;
                    }
                    removeCard(card.unique);
                    setSwiping(null);
                  }
                }}
              >
                <img
                  src={card.url}
                  alt="Cat"
                  loading={isTop ? "eager" : "lazy"}
                  onError={() => {
                    if (swipeTimeoutRef.current) {
                      window.clearTimeout(swipeTimeoutRef.current);
                      swipeTimeoutRef.current = null;
                    }
                    removeCard(card.unique);
                    if (swiping?.unique === card.unique) setSwiping(null);
                  }}
                />
              </motion.article>
            );
          })}
        </div>

        <div className="actions">
          <button className="paw one" aria-label="One Paw" onClick={() => commitSwipe("left")}>🐾</button>
          <button className="paw two" aria-label="Two Paws" onClick={() => commitSwipe("right")}>🐾🐾</button>
        </div>

        {fetchError ? <p className="errorText">{fetchError}</p> : null}
      </section>

      <section className="likedPanel">
        <div className="likedHead">
          <h2>Two-Paw Favorites</h2>
          <button
            className="ghost"
            onClick={() => {
              setLiked([]);
              saveLiked([]);
            }}
          >
            Clear
          </button>
        </div>

        <div className="likedGrid">
          {liked.slice(0, 48).map((card) => (
            <figure key={card.unique} className="likedItem">
              <img src={card.url} alt="Saved favorite cat" loading="lazy" />
            </figure>
          ))}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
