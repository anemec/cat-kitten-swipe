export interface CatPhoto {
  unique: string;
  id: string;
  url: string;
  width: number;
  height: number;
  tags: string[];
  mime: string;
  source: "TheCatAPI" | "CATAAS";
}

export interface PreferenceWeights {
  tags: Record<string, number>;
  source: Record<string, number>;
  orientation: Record<string, number>;
  media: Record<string, number>;
}

export interface CatFeatures {
  tags: string[];
  source: string;
  orientation: "landscape" | "portrait" | "square";
  media: "gif" | "photo";
}
