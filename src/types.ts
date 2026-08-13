export type QueryIntent = 
  | 'commercial_comparison' 
  | 'direct_recommendation' 
  | 'alternatives_search' 
  | 'feature_specific' 
  | 'localized_vendor' 
  | 'pricing_roi';

export type AiEngine = 'Gemini' | 'ChatGPT' | 'Perplexity' | 'Claude' | 'SearchGPT';

export type RecommendationStatus = 
  | 'recommended_leader' 
  | 'secondary_mention' 
  | 'omitted' 
  | 'inaccurate_claim' 
  | 'negative_sentiment';

export interface EngineResult {
  engine: AiEngine;
  status: RecommendationStatus;
  position: number | null; // 1 = top recommendation, 2 = runner up, null = omitted
  excerpt: string;
  citations: string[];
  keyInaccuracy?: string;
  keyOmissionReason?: string;
}

export interface AuditQuery {
  id: string;
  intent: QueryIntent;
  queryText: string;
  targetPersona: string;
  monthlySearchVolumeEstimate: string;
  engines: Record<AiEngine, EngineResult>;
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
  accuracyRate: number; // % of mentions that were accurate
  executiveSummary: string;
  queriesTested: AuditQuery[];
  inaccuracies: InaccuracyItem[];
  omissions: OmissionReason[];
  remediationPlan: RemediationTask[];
  competitorBenchmarks: CompetitorBenchmark[];
  historicalScores?: { date: string; score: number; sov: number }[];
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
