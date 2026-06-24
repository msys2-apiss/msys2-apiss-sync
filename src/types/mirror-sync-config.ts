export interface MirrorSyncBranchPair {
  Upstream: string;
  Mirror: string;
}

export interface MirrorSyncConfig {
  UpstreamUrl: string;
  Branches: MirrorSyncBranchPair[];
  SyncTags?: boolean;
  Notify?: {
    Enabled?: boolean;
    Repository?: string;
    EventType?: string;
  };
}
