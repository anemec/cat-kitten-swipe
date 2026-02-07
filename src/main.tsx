import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { motion } from "framer-motion";
import TinderCard from "react-tinder-card";
import type { CatPhoto } from "./types";
import "./app.css";

const CAT_API_URL = "https://api.thecatapi.com/v1/images/search?limit=24";
const CATAAS_API_URL = "https://cataas.com/api/cats";
const SHIBE_API_URL = "https://shibe.online/api/cats?count=28&urls=true&httpsUrls=true";

const PRELOAD_TARGET = 40;
const QUEUE_LOW_WATERMARK = 30;
const INCOMING_CAP = 90;

type SwipeDirection = "left" | "right" | "up" | "down";

type TinderApi = {
  swipe: (dir?: SwipeDirection) => Promise<void>;
  restoreCard: () => Promise<void>;
};

type CardRefMap = Record<string, React.RefObject<TinderApi>>;

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
    width: item.width ?? 900,
    height: item.height ?? 900,
    tags: [],
    mime: extToMime(item.url),
    source: "TheCatAPI",
  }));
}

async function fetchCataas(): Promise<CatPhoto[]> {
  const skip = Math.floor(Math.random() * 6000);
  const response = await fetch(`${CATAAS_API_URL}?limit=30&skip=${skip}`);
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
      const id = url.split("/").pop()?.split("?")[0] ?? crypto.randomUUID();
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

function App(): JSX.Element {
  const [cards, setCards] = useState<CatPhoto[]>([]);
  const [liked, setLiked] = useState<CatPhoto[]>(() => loadLiked());
  const [fetchError, setFetchError] = useState<string>("");
  const [isFetching, setIsFetching] = useState(false);

  const seenRef = useRef<Set<string>>(new Set(liked.map((card) => card.unique)));
  const preloadedRef = useRef<Set<string>>(new Set());
  const preloadJobsRef = useRef<Map<string, Promise<void>>>(new Map());
  const refsRef = useRef<CardRefMap>({});
  const fetchingRef = useRef(false);

  const topCard = cards[cards.length - 1] ?? null;

  const swipeThreshold = useMemo(() => {
    if (typeof window === "undefined") return 90;
    return Math.max(90, Math.floor(window.innerWidth * 0.22));
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
    }).finally(() => {
      preloadJobsRef.current.delete(url);
    });

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
        throw new Error("All photo APIs failed");
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
    preloadFromStack(cards);
  }, [cards, preloadFromStack]);

  const getCardRef = (id: string): React.RefObject<TinderApi> => {
    if (!refsRef.current[id]) {
      refsRef.current[id] = React.createRef();
    }
    return refsRef.current[id];
  };

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

  const rateTwoPaws = useCallback((card: CatPhoto) => {
    setLiked((prev) => {
      const next = [card, ...prev.filter((item) => item.unique !== card.unique)].slice(0, 160);
      saveLiked(next);
      return next;
    });
  }, []);

  const onSwipe = useCallback(
    (dir: SwipeDirection, card: CatPhoto) => {
      if (dir === "right") {
        rateTwoPaws(card);
      }
      removeCard(card.unique);
    },
    [rateTwoPaws, removeCard],
  );

  const onCardError = useCallback(
    (card: CatPhoto) => {
      removeCard(card.unique);
    },
    [removeCard],
  );

  const swipeByButton = useCallback(async (dir: SwipeDirection) => {
    const card = cards[cards.length - 1];
    if (!card) return;
    await refsRef.current[card.unique]?.current?.swipe(dir);
  }, [cards]);

  return (
    <main className="scene">
      <motion.div className="atmo a" animate={{ y: [-8, 8, -8], x: [-6, 10, -6] }} transition={{ repeat: Infinity, duration: 14, ease: "easeInOut" }} />
      <motion.div className="atmo b" animate={{ y: [6, -10, 6], x: [8, -12, 8] }} transition={{ repeat: Infinity, duration: 16, ease: "easeInOut" }} />

      <header className="hero">
        <h1>CatSwipe</h1>
      </header>

      <section className="deckWrap">
        <div className="deck">
          {cards.length === 0 && (
            <div className="emptyCard">
              {isFetching ? "Finding cats and kittens..." : "No cats loaded yet."}
            </div>
          )}

          {cards.map((card, index) => {
            const depth = cards.length - 1 - index;
            const isTop = depth === 0;

            return (
              <TinderCard
                key={card.unique}
                ref={getCardRef(card.unique)}
                className="swipe"
                preventSwipe={["up", "down"]}
                swipeRequirementType="position"
                swipeThreshold={swipeThreshold}
                onSwipe={(dir) => onSwipe(dir as SwipeDirection, card)}
                onCardLeftScreen={() => {
                  // Backup in case some browsers skip onSwipe callbacks.
                  removeCard(card.unique);
                }}
              >
                <article
                  className={`card ${isTop ? "top" : ""}`}
                  style={{
                    zIndex: index + 1,
                    transform: depth > 0 ? `translateY(${Math.min(depth * 6, 18)}px) scale(${1 - Math.min(depth * 0.016, 0.04)})` : undefined,
                    opacity: depth > 2 ? 0 : 1,
                  }}
                >
                  <img src={card.url} alt="Cat" loading={isTop ? "eager" : "lazy"} onError={() => onCardError(card)} />
                </article>
              </TinderCard>
            );
          })}
        </div>

        <div className="actions">
          <button className="paw one" aria-label="One Paw" onClick={() => void swipeByButton("left")}>🐾</button>
          <button className="paw two" aria-label="Two Paws" onClick={() => void swipeByButton("right")}>🐾🐾</button>
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
