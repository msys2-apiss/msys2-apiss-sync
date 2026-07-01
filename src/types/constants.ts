/** Block 3 tooling branch on each msys2-apiss/* mirror repo. */
export const MIRROR_SYNC_BRANCH = 'msys2-apiss-mirror-sync';

/** Block 4 tooling branch on destination repo msys2-apiss/msys2-apiss. */
export const MIRROR_MERGE_BRANCH = 'msys2-apiss-mirror-merge';

/** Block 2 -> Block 3 workflow_dispatch input on mirror-sync.yml. */
export const WORKFLOW_DISPATCH_MIRROR_SYNC = 'workflow_dispatch_mirror_sync';

/** Block 3 -> Block 4 workflow_dispatch input on mirror-merge.yml. */
export const WORKFLOW_DISPATCH_MIRROR_MERGE = 'workflow_dispatch_mirror_merge';

export const GITHUB_API = 'https://api.github.com';

/** Block 3 bundled CLI filename (committed in tooling repo; CI downloads by URL). */
export const MIRROR_SYNC_BUNDLE = 'mirror-sync.mjs';

/** Block 4 bundled CLI filename (committed in tooling repo; CI downloads by URL). */
export const MIRROR_MERGE_BUNDLE = 'mirror-merge.mjs';

/** Install templates copied by mirror-init (workflow YAML). */
export const MIRROR_TEMPLATE_DIR = 'config/mirror-template';

/** Per-mirror Block 3 config; repo name matches filename (<repo>.json). */
export const MIRROR_SYNC_CONFIG_DIR = 'config/mirror-sync';

/** Prebuilt Block 3/4 bundles (yarn pack-toolings). */
export const MIRROR_TOOLINGS_TEMPLATE_DIR = 'config/mirror-template/toolings';

/** Block 4 replay config path under downloaded .github/toolings/ in CI. */
export const MIRROR_MERGE_BUNDLED_CONFIG_REL = 'config/mirror-merge.json';

/** Block 3 bundle install dir on mirror/destination tooling branches. */
export const MIRROR_SYNC_TOOLINGS_DIR = '.github/toolings';

/** Block 4 replay config in the tooling repo (local yarn mirror-merge). */
export const MIRROR_MERGE_CONFIG_PATH = 'config/mirror-merge.json';

/** Block 2 poll config in the tooling repo. */
export const MIRROR_POLL_CONFIG_PATH = 'config/mirror-poll.json';

/** Repo -> per-repo tooling digest map (mirror-init --push only). */
export const TOOLING_DIGEST_PATH = 'config/digest.json';

/** This tooling repository (Block 2 workflows on main). */
export const TOOLING_REPO = 'msys2-apiss-sync';

/** Default branch for TOOLING_REPO (mirror-poll.yml lives here). */
export const TOOLING_DEFAULT_BRANCH = 'main';

/** GitHub raw URL base for committed mirror-template toolings (CI download). */
export const TOOLING_REPO_RAW_BASE = `https://raw.githubusercontent.com/msys2-apiss/${TOOLING_REPO}/${TOOLING_DEFAULT_BRANCH}`;

/** Block 3 CLI bundle URL (downloaded in mirror-sync.yml; not committed on mirror repos). */
export const MIRROR_SYNC_BUNDLE_URL = `${TOOLING_REPO_RAW_BASE}/${MIRROR_TOOLINGS_TEMPLATE_DIR}/${MIRROR_SYNC_BUNDLE}`;

/** Block 4 CLI bundle URL (downloaded in mirror-merge.yml; not committed on destination). */
export const MIRROR_MERGE_BUNDLE_URL = `${TOOLING_REPO_RAW_BASE}/${MIRROR_TOOLINGS_TEMPLATE_DIR}/${MIRROR_MERGE_BUNDLE}`;

/** Block 4 replay config URL (downloaded with mirror-merge.mjs in CI). */
export const MIRROR_MERGE_CONFIG_URL = `${TOOLING_REPO_RAW_BASE}/${MIRROR_MERGE_CONFIG_PATH}`;

/** Block 3 per-mirror config URL (downloaded in mirror-sync.yml by repository name). */
export function mirrorSyncConfigUrl(repoName: string): string {
  return `${TOOLING_REPO_RAW_BASE}/${MIRROR_SYNC_CONFIG_DIR}/${repoName}.json`;
}
