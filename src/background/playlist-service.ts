import { PLAYLISTS_CACHE_TTL_MS } from '../shared/constants';
import { AppError } from '../shared/errors';
import type { AddResult, PlaylistsResult } from '../shared/messages';
import { getLocal, setLocal } from '../shared/storage';
import type { PlaylistSummary, SpotifyUser } from '../shared/types';
import type { SpotifyClient } from '../spotify/client';
import { addTrackToPlaylist, createPlaylist, listPlaylists, playlistContainsTrack } from '../spotify/playlists';

export interface PlaylistServiceDeps {
  client: SpotifyClient;
  getUser(): Promise<SpotifyUser>;
  now(): number;
}

/** Leitura e escrita de playlists. Toda escrita usa a Web API com o token do próprio usuário. */
export class PlaylistService {
  constructor(private readonly deps: PlaylistServiceDeps) {}

  async list(refresh = false): Promise<PlaylistsResult> {
    const cached = await getLocal('playlistsCache');
    if (!refresh && cached && this.deps.now() - cached.fetchedAt < PLAYLISTS_CACHE_TTL_MS) return cached;
    const user = await this.deps.getUser();
    const playlists = await listPlaylists(this.deps.client, user.id);
    const result = { playlists, fetchedAt: this.deps.now() };
    await setLocal('playlistsCache', result);
    return result;
  }

  async add(playlistId: string, trackUri: string, allowDuplicate = false): Promise<AddResult> {
    const known = (await getLocal('playlistsCache'))?.playlists.find((p) => p.id === playlistId);
    if (known && !known.editable) {
      throw new AppError('forbidden', `“${known.name}” é somente leitura: você não pode adicionar faixas a ela.`);
    }

    let duplicateCheck: AddResult['duplicateCheck'] = 'skipped';
    if (!allowDuplicate) {
      const contains = await playlistContainsTrack(this.deps.client, playlistId, trackUri, known?.trackCount);
      if (contains === 'yes') return { status: 'duplicate', playlistName: known?.name ?? '', duplicateCheck: 'done' };
      duplicateCheck = contains === 'no' ? 'done' : 'skipped';
    }

    await addTrackToPlaylist(this.deps.client, playlistId, trackUri);
    await this.bumpCount(playlistId, 1);
    return { status: 'added', playlistName: known?.name ?? '', duplicateCheck };
  }

  async create(name: string, isPublic: boolean, trackUri?: string): Promise<{ playlist: PlaylistSummary; added: boolean }> {
    const user = await this.deps.getUser();
    const playlist = await createPlaylist(this.deps.client, user.id, name, isPublic);
    const cached = await getLocal('playlistsCache');
    await setLocal('playlistsCache', {
      playlists: [playlist, ...(cached?.playlists ?? [])],
      fetchedAt: cached?.fetchedAt ?? this.deps.now(),
    });
    if (!trackUri) return { playlist, added: false };
    await addTrackToPlaylist(this.deps.client, playlist.id, trackUri);
    await this.bumpCount(playlist.id, 1);
    return { playlist: { ...playlist, trackCount: (playlist.trackCount ?? 0) + 1 }, added: true };
  }

  private async bumpCount(playlistId: string, delta: number): Promise<void> {
    const cached = await getLocal('playlistsCache');
    if (!cached) return;
    await setLocal('playlistsCache', {
      ...cached,
      playlists: cached.playlists.map((p) => (p.id === playlistId ? { ...p, trackCount: (p.trackCount ?? 0) + delta } : p)),
    });
  }
}
