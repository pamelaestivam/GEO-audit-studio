export type QueryIntent = 
  | 'commercial_comparison' 
  | 'direct_recommendation' 
  | 'alternatives_search' 
  | 'feature_specific' 
  | 'localized_vendor' 
  | 'pricing_roi';

export type AiEngine = 'Gemini' | 'ChatGPT' | 'Perplexity' | 'Claude';

export type RecommendationStatus =
  | 'recommended_leader'
  | 'secondary_mention'
  | 'omitted'
  | 'inaccurate_claim'
  | 'negative_sentiment'
  /** The engine call failed; excluded from every metric rather than scored as absent. */
  | 'retrieval_failed';

export interface EngineResult {
  engine: AiEngine;
  status: RecommendationStatus;
  position: number | null; // 1 = top recommendation, 2 = runner up, null = omitted
  excerpt: string;
  citations: string[];
  keyInaccuracy?: string;
  keyOmissionReason?: string;
}

/** Verbatim record of what an answer engine returned, so findings stay auditable. */
export interface QueryEvidenceRecord {
  answerText: string;
  citations: { url: string; title: string; domain: string }[];
  searchQueries: string[];
  capturedAt: string;
  engine: string;
  error?: string;
}

export interface AuditQuery {
  id: string;
  intent: QueryIntent;
  queryText: string;
  targetPersona: string;
  /**
   * Search volume is not measured by this product - it would need a keyword
   * data provider. Absent unless a real source supplies it.
   */
  monthlySearchVolumeEstimate?: string;
  /** Only engines actually queried appear here. */
  engines: Partial<Record<AiEngine, EngineResult>>;
  /** One record per engine queried for this query. */
  evidence?: QueryEvidenceRecord[];
  /** Brands the engine named ahead of the audited business. */
  competitorsAhead?: string[];
  /** 0-100; how early the brand appears in the answer. */
  prominence?: number;
}

/** A domain the answer engine relied on when composing its answers. */
export interface CitationSource {
  domain: string;
  citationCount: number;
  queryCount: number;
  isOwned: boolean;
  sampleUrl: string;
  sampleTitle: string;
}

export interface InaccuracyItem {
  id: string;
  engine: AiEngine;
  queryId: string;
  queryText: string;
  claimedFact: string;
  actualFact: string;
  impactSeverity: 'high' | 'medium' | 'low';
  sourceOriginUrl?: string;
  remediationTaskId?: string;
}

export interface OmissionReason {
  id: string;
  category: 'Schema & Entity Data' | 'Review & Directory Signals' | 'Comparison & Top 10 Coverage' | 'Reddit / Forum Sentiment' | 'Pricing & Feature Clarity';
  description: string;
  affectedQueriesCount: number;
  rootCause: string;
  recommendation: string;
}

export interface RemediationTask {
  id: string;
  title: string;
  category: 'Schema Markup' | 'Digital PR & Aggregators' | 'Content Entity Refactoring' | 'Authority & Citations' | 'Pricing Transparency';
  priority: 'P0 Critical' | 'P1 High' | 'P2 Medium' | 'P3 Maintenance';
  effort: 'Quick Win (< 2h)' | 'Moderate (1-2 days)' | 'Strategic (1-2 weeks)';
  expectedGain: string;
  description: string;
  stepByStepInstructions: string[];
  codeSnippet?: string;
  targetUrls?: string[];
  completed: boolean;
}

export interface CompetitorBenchmark {
  name: string;
  domain: string;
  shareOfVoice: number; // 0-100%
  topRecommendedCount: number;
  mainCitationSources: string[];
}

export interface AuditReport {
  id: string;
  createdAt: string;
  businessName: string;
  domain: string;
  industry: string;
  coreOfferings: string;
  targetAudience: string;
  competitors: string[];
  geoVisibilityScore: number; // 0 - 100 Generative Engine Optimization Score
  shareOfVoice: number; // % of queries business appeared in
  leaderShare: number; // % of queries where business was #1 recommended
  /** % of mentions free of inaccuracies. null when the brand was never mentioned. */
  accuracyRate: number | null;
  executiveSummary: string;
  queriesTested: AuditQuery[];
  inaccuracies: InaccuracyItem[];
  omissions: OmissionReason[];
  remediationPlan: RemediationTask[];
  competitorBenchmarks: CompetitorBenchmark[];
  historicalScores?: { date: string; score: number; sov: number }[];
  /** Domains the answer engine cited, ranked by frequency. */
  citationSources?: CitationSource[];
  /** Vendors the engines named that the client never asked us to track. */
  untrackedRivals?: string[];
  /** True when the audit could not collect evidence; metrics are not measurements. */
  degraded?: boolean;
  degradedReason?: string;
  observationsAttempted?: number;
  observationsWithEvidence?: number;
  enginesRequested?: string[];
  /** Engines genuinely queried in this audit - never a claim about untested ones. */
  measuredEngines?: string[];
  /** Average prominence (0-100) of the brand across answers where it appeared. */
  avgProminence?: number;
  queriesAttempted?: number;
  queriesWithEvidence?: number;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role?: string;
  company?: string;
  avatarUrl?: string;
  createdAt?: string;
}

export interface MonitoringConfig {
  enabled: boolean;
  frequency: 'daily' | 'weekly' | 'biweekly';
  alertThreshold: number;
  notificationEmails: string[];
  webhookUrl?: string;
  lastRunDate: string;
  nextRunDate: string;
}
