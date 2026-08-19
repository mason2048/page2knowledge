export type KnowledgeWarning = {
  code: string;
  message: string;
  chunkIds?: string[];
};

export type SourceKind = 'web' | 'pdf' | 'transcript' | 'site';

export type KnowledgeChunk = {
  id: string;
  title: string;
  titlePath: string[];
  markdown: string;
  revision: string;
  source: {
    url: string;
    locator: string;
  };
};

export type KeyFact = {
  id: string;
  statement: string;
  chunkId: string;
  source: KnowledgeChunk['source'] & { revision: string; titlePath: string[] };
};

export type PageSnapshot = {
  requestedUrl: string;
  finalUrl: string;
  fetchedAt: string;
  status: number;
  contentType: string;
  contentLength: number;
  contentHash: string;
  title: string;
  author: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
};

export type KnowledgeResult = {
  schemaVersion: '0.1';
  packageId: string;
  name: string;
  sourceKind?: SourceKind;
  snapshot: PageSnapshot;
  markdown: string;
  summary: string;
  keyFacts: KeyFact[];
  chunks: KnowledgeChunk[];
  warnings: KnowledgeWarning[];
};

export type ContextPackage = {
  schemaVersion: '0.1';
  packageId: string;
  name: string;
  kind: 'web' | 'mixed';
  createdAt: string;
  producer: { name: 'page2knowledge'; version: '0.2.1' };
  items: Array<{
    id: string;
    type: 'fact' | 'reference';
    title: string;
    content: string;
    scope: 'project';
    source: {
      uri: string;
      revision: string;
      locator: string;
    };
    validity: {
      observedAt: string;
      expiresAt: null;
      confidence: number;
    };
    sensitivity: 'public' | 'internal';
    tags: string[];
  }>;
  warnings: string[];
};

export type LineDiffEntry = {
  kind: 'context' | 'added' | 'removed';
  text: string;
  beforeLine: number | null;
  afterLine: number | null;
};

export type ChunkVersion = KnowledgeChunk;

export type ChunkVersionDiff = {
  matchKey: string;
  titlePath: string[];
  occurrence: number;
  status: 'added' | 'removed' | 'changed' | 'unchanged';
  before: ChunkVersion | null;
  after: ChunkVersion | null;
  beforeRevision: string | null;
  afterRevision: string | null;
  lineDiff: LineDiffEntry[];
  readableDiff: string;
  beforeFactIds: string[];
  afterFactIds: string[];
  affectedChunkIds: string[];
  affectedFactIds: string[];
};

export type KnowledgeVersionDiff = {
  sourceUrl: string;
  beforePackageId: string;
  afterPackageId: string;
  summary: { added: number; removed: number; changed: number; unchanged: number };
  blocks: ChunkVersionDiff[];
  added: ChunkVersionDiff[];
  removed: ChunkVersionDiff[];
  changed: ChunkVersionDiff[];
  unchanged: ChunkVersionDiff[];
  affectedChunkIds: string[];
  affectedFactIds: string[];
};

export type CrawlPage = {
  url: string;
  depth: number;
  status: 'processed' | 'skipped' | 'failed';
  title?: string;
  reason?: string;
  result?: KnowledgeResult;
};

export type CrawlResult = {
  seedUrl: string;
  startedAt: string;
  completedAt: string;
  limits: { maxPages: number; maxDepth: number };
  pages: CrawlPage[];
  combined: KnowledgeResult | null;
  warnings: KnowledgeWarning[];
};

export type SearchHit = {
  chunkId: string;
  score: number;
  title: string;
  content: string;
  source: KnowledgeChunk['source'] & { revision: string; titlePath: string[] };
};

export type ChatCitation = {
  index: number;
  chunkId: string;
  label: string;
  source: SearchHit['source'];
};

export type ChatAnswer = {
  answer: string;
  grounded: boolean;
  citations: ChatCitation[];
  hits: SearchHit[];
};

export type ScheduleRecord = {
  id: string;
  url: string;
  intervalMinutes: number;
  enabled: boolean;
  confirmedAt: string;
  createdAt: string;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: 'never' | 'running' | 'success' | 'failed';
  lastError: string | null;
  lastRevision: string | null;
  runCount: number;
};

export type ApiError = {
  error: {
    code: string;
    message: string;
    suggestion: string;
  };
};
