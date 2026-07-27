export type TrackReference = {
  addedAt?: string | undefined;
  album?: string | undefined;
  artists: string[];
  durationSeconds?: number | undefined;
  explicit?: boolean | undefined;
  id: string;
  itemId?: string | undefined;
  tidalUrl?: string | undefined;
  title: string;
  unavailable?: boolean | undefined;
};

export type FavoritesDocument = {
  kind: 'favorites';
  schemaVersion: 1;
  tracks: TrackReference[];
};

export type PlaylistDocument = {
  description: string;
  id: string | null;
  kind: 'playlist';
  localId?: string | undefined;
  schemaVersion: 1;
  title: string;
  tracks: TrackReference[];
};

export type TidekeeperConfig = {
  countryCode?: string | undefined;
  libraryDirectory: string;
  schemaVersion: 1;
};

export type LibrarySnapshot = {
  config: TidekeeperConfig;
  favorites: FavoritesDocument;
  playlists: PlaylistDocument[];
};
