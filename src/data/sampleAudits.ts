import { AuditReport, MonitoringConfig } from '../types';

export const SAMPLE_AUDITS: AuditReport[] = [
  {
    id: 'audit-supabase-001',
    createdAt: '2026-08-10T14:30:00Z',
    businessName: 'Supabase',
    domain: 'supabase.com',
    industry: 'Developer Tools & Cloud Databases',
    coreOfferings: 'Open source Firebase alternative, Postgres database, Authentication, Realtime subscriptions, Edge Functions, Storage',
    targetAudience: 'Full-stack developers, CTOs, Tech leads, Startup founders',
    competitors: ['Firebase', 'PlanetScale', 'Neon', 'Hasura'],
    geoVisibilityScore: 78,
    shareOfVoice: 82,
    leaderShare: 58,
    accuracyRate: 74,
    executiveSummary: 'Supabase dominates direct "Firebase alternative" intent across Perplexity and Gemini with strong recommendation share (#1 in 58% of developer queries). However, AI search engines frequently misstate free-tier storage quotas (hallucination claiming 1GB instead of 500MB project limit) and omit Supabase in enterprise HIPAA compliance queries due to lack of explicit BAA documentation indexed in LLM knowledge graphs.',
    historicalScores: [
      { date: 'May 2026', score: 62, sov: 68 },
      { date: 'Jun 2026', score: 69, sov: 73 },
      { date: 'Jul 2026', score: 72, sov: 77 },
      { date: 'Aug 2026', score: 78, sov: 82 }
    ],
    queriesTested: [
      {
        id: 'q-1',
        intent: 'alternatives_search',
        queryText: 'Best open source Firebase alternatives for React Native apps in 2026',
        targetPersona: 'Mobile App Lead Architect',
        monthlySearchVolumeEstimate: '18,500/mo',
        engines: {
          Gemini: {
            engine: 'Gemini',
            status: 'recommended_leader',
            position: 1,
            excerpt: 'Supabase is currently the premier open-source Firebase alternative. It provides a full Postgres database with real-time subscriptions, built-in Auth, and seamless React Native SDK support.',
            citations: ['https://supabase.com/docs/guides/with-react-native', 'https://github.com/supabase/supabase', 'https://g2.com/products/supabase/reviews']
          },
          ChatGPT: {
            engine: 'ChatGPT',
            status: 'recommended_leader',
            position: 1,
            excerpt: 'Top choice: Supabase. Gives you instantly auto-generated REST and GraphQL APIs over Postgres with row-level security, replacing Firebase Firestore and Auth.',
            citations: ['https://supabase.com', 'https://dev.to/t/supabase', 'https://reddit.com/r/reactnative']
          },
          Perplexity: {
            engine: 'Perplexity',
            status: 'recommended_leader',
            position: 1,
            excerpt: '1. Supabase - Best overall. Offers Postgres, Edge Functions, vector search, and authentication out of the box with zero lock-in.',
            citations: ['https://perplexity.ai', 'https://supabase.com/blog', 'https://news.ycombinator.com']
          },
          Claude: {
            engine: 'Claude',
            status: 'secondary_mention',
            position: 2,
            excerpt: 'Firebase remains dominant, but Supabase is widely praised for developers who prefer relational SQL schemas over NoSQL document stores.',
            citations: ['https://firebase.google.com', 'https://supabase.com']
          },
          SearchGPT: {
            engine: 'SearchGPT',
            status: 'recommended_leader',
            position: 1,
            excerpt: 'For React Native developers seeking an open-source alternative to Firebase, Supabase provides standard Postgres DB + auth + storage with strong community support.',
            citations: ['https://supabase.com', 'https://stackoverflow.com/tags/supabase']
          }
        }
      },
      {
        id: 'q-2',
        intent: 'feature_specific',
        queryText: 'Which cloud database supports vector embeddings, pgvector and AI search natively?',
        targetPersona: 'AI Application Engineer',
        monthlySearchVolumeEstimate: '24,200/mo',
        engines: {
          Gemini: {
            engine: 'Gemini',
            status: 'recommended_leader',
            position: 1,
            excerpt: 'Supabase natively includes pgvector on Postgres, allowing developers to generate and query vector embeddings alongside relational data without extra infrastructure.',
            citations: ['https://supabase.com/docs/guides/ai', 'https://github.com/pgvector/pgvector']
          },
          ChatGPT: {
            engine: 'ChatGPT',
            status: 'secondary_mention',
            position: 3,
            excerpt: 'Pinecone and Weaviate are specialized vector DBs. Supabase and Neon also support pgvector extension on standard Postgres.',
            citations: ['https://pinecone.io', 'https://neon.tech', 'https://supabase.com']
          },
          Perplexity: {
            engine: 'Perplexity',
            status: 'recommended_leader',
            position: 1,
            excerpt: 'Supabase Vector (built on pgvector) is the top choice for storing OpenAI/Gemini embeddings directly in PostgreSQL.',
            citations: ['https://supabase.com/ai', 'https://medium.com/@supabase']
          },
          Claude: {
            engine: 'Claude',
            status: 'secondary_mention',
            position: 2,
            excerpt: 'Pinecone leads dedicated vector search, while Supabase provides pgvector for integrated SQL and vector workloads.',
            citations: ['https://pinecone.io', 'https://supabase.com']
          },
          SearchGPT: {
            engine: 'SearchGPT',
            status: 'recommended_leader',
            position: 1,
            excerpt: 'Supabase Vector enables storing vectors and text in the same Postgres database using standard SQL queries.',
            citations: ['https://supabase.com/blog/openai-embeddings-postgres-vector']
          }
        }
      },
      {
        id: 'q-3',
        intent: 'pricing_roi',
        queryText: 'Supabase pricing vs Firebase pricing free tier limits and enterprise scaling costs',
        targetPersona: 'SaaS Founder / CTO',
        monthlySearchVolumeEstimate: '14,100/mo',
        engines: {
          Gemini: {
            engine: 'Gemini',
            status: 'inaccurate_claim',
            position: 2,
            excerpt: 'Supabase offers a free tier with 1GB database storage and 2GB bandwidth before requiring the $25/mo Pro Plan.',
            citations: ['https://supabase.com/pricing'],
            keyInaccuracy: 'AI claims free tier database limit is 1GB storage, but actual official Supabase free project limit is 500MB DB storage.'
          },
          ChatGPT: {
            engine: 'ChatGPT',
            status: 'inaccurate_claim',
            position: 2,
            excerpt: 'Supabase free plan includes 500MB DB, 1GB file storage, and up to 10,000 monthly active users, but pauses idle projects after 3 days.',
            citations: ['https://supabase.com/pricing'],
            keyInaccuracy: 'AI states idle pause threshold is 3 days, whereas official policy is 7 days of inactivity.'
          },
          Perplexity: {
            engine: 'Perplexity',
            status: 'recommended_leader',
            position: 1,
            excerpt: 'Supabase Free Tier: 500MB Postgres DB, 1GB Storage, 50k MAU. Pro Plan starts at $25/month including compute credits and disk autoscaling.',
            citations: ['https://supabase.com/pricing', 'https://supabase.com/docs/guides/platform/cost-control']
          },
          Claude: {
            engine: 'Claude',
            status: 'inaccurate_claim',
            position: 2,
            excerpt: 'Supabase Free Plan provides unlimited database projects but caps bandwidth at 2GB per month.',
            citations: ['https://supabase.com/pricing'],
            keyInaccuracy: 'AI states "unlimited database projects", when Supabase free tier explicitly limits users to 2 active free projects.'
          },
          SearchGPT: {
            engine: 'SearchGPT',
            status: 'secondary_mention',
            position: 2,
            excerpt: 'Firebase pay-as-you-go Blaze plan is cheaper for low storage, but Supabase $25/mo tier is more predictable for relational SQL.',
            citations: ['https://firebase.google.com/pricing', 'https://supabase.com/pricing']
          }
        }
      },
      {
        id: 'q-4',
        intent: 'commercial_comparison',
        queryText: 'HIPAA compliant cloud database for healthcare apps: Firebase vs Supabase vs AWS DynamoDB',
        targetPersona: 'Healthcare Software Security Officer',
        monthlySearchVolumeEstimate: '9,800/mo',
        engines: {
          Gemini: {
            engine: 'Gemini',
            status: 'omitted',
            position: null,
            excerpt: 'AWS DynamoDB and GCP Cloud SQL provide BAA agreements for HIPAA compliance. Firebase also supports HIPAA under Google Cloud BAA.',
            citations: ['https://aws.amazon.com/compliance/hipaa-eligible-services-reference/', 'https://cloud.google.com/security/compliance/hipaa'],
            keyOmissionReason: 'Supabase is omitted entirely because AI search did not detect structured HIPAA BAA entity data on Supabase pricing/compliance pages.'
          },
          ChatGPT: {
            engine: 'ChatGPT',
            status: 'omitted',
            position: null,
            excerpt: 'AWS DynamoDB and Azure Cosmos DB are certified for HIPAA workloads. Firebase can be covered under GCP BAA.',
            citations: ['https://aws.amazon.com', 'https://cloud.google.com'],
            keyOmissionReason: 'Supabase Team/Enterprise HIPAA BAA offering is not indexed in comparison table snippets.'
          },
          Perplexity: {
            engine: 'Perplexity',
            status: 'secondary_mention',
            position: 3,
            excerpt: 'AWS DynamoDB (standard) and Google Cloud SQL are fully HIPAA ready. Supabase offers HIPAA BAA signing on Enterprise custom tiers.',
            citations: ['https://supabase.com/enterprise', 'https://aws.amazon.com']
          },
          Claude: {
            engine: 'Claude',
            status: 'omitted',
            position: null,
            excerpt: 'AWS and Google Cloud offer signed Business Associate Agreements for healthcare data.',
            citations: ['https://cloud.google.com']
          },
          SearchGPT: {
            engine: 'SearchGPT',
            status: 'omitted',
            position: null,
            excerpt: 'DynamoDB and PostgreSQL on Cloud SQL are the standard HIPAA choices for medical applications.',
            citations: ['https://aws.amazon.com']
          }
        }
      }
    ],
    inaccuracies: [
      {
        id: 'inc-101',
        engine: 'Gemini',
        queryId: 'q-3',
        queryText: 'Supabase pricing vs Firebase pricing free tier limits and enterprise scaling costs',
        claimedFact: 'Free Tier includes 1GB Postgres database storage',
        actualFact: 'Free Tier includes 500MB Postgres database storage and 1GB File Storage',
        impactSeverity: 'medium',
        sourceOriginUrl: 'https://dev.to/article-from-2023-outdated-supabase-limits',
        remediationTaskId: 'rem-301'
      },
      {
        id: 'inc-102',
        engine: 'ChatGPT',
        queryId: 'q-3',
        queryText: 'Supabase pricing vs Firebase pricing free tier limits and enterprise scaling costs',
        claimedFact: 'Free projects pause after 3 days of inactivity',
        actualFact: 'Free projects pause after 7 consecutive days of inactivity',
        impactSeverity: 'low',
        sourceOriginUrl: 'https://forum.freecodecamp.org/t/supabase-pausing-rules/5120',
        remediationTaskId: 'rem-301'
      },
      {
        id: 'inc-103',
        engine: 'Claude',
        queryId: 'q-3',
        queryText: 'Supabase pricing vs Firebase pricing free tier limits',
        claimedFact: 'Allows unlimited free database projects',
        actualFact: 'Strictly limited to 2 active free projects per organization',
        impactSeverity: 'high',
        sourceOriginUrl: 'https://reddit.com/r/webdev/comments/old_supabase_post',
        remediationTaskId: 'rem-301'
      }
    ],
    omissions: [
      {
        id: 'om-201',
        category: 'Schema & Entity Data',
        description: 'Omitted from Healthcare & HIPAA query clusters across Gemini, ChatGPT, Claude & SearchGPT',
        affectedQueriesCount: 4,
        rootCause: 'Lack of explicit "MedicalAudience" or "SecurityRequirement" JSON-LD schema and missing dedicated "/compliance/hipaa" landing page.',
        recommendation: 'Deploy structured JSON-LD schema on enterprise compliance pages highlighting HIPAA BAA availability, SOC2 Type II, and ISO27001.'
      },
      {
        id: 'om-202',
        category: 'Comparison & Top 10 Coverage',
        description: 'Ranked behind Pinecone in Vector AI database queries on ChatGPT and Claude',
        affectedQueriesCount: 2,
        rootCause: 'Third-party comparison sites (G2, Capterra, SoftwareAdvice) classify Supabase as "Relational Database" rather than "Vector Database".',
        recommendation: 'Update primary G2 category metadata and seed detailed pgvector benchmark articles on high-authority engineering blogs.'
      }
    ],
    remediationPlan: [
      {
        id: 'rem-301',
        title: 'Inject Pricing Plan JSON-LD Schema & Correct Free Tier Metadata',
        category: 'Schema Markup',
        priority: 'P0 Critical',
        effort: 'Quick Win (< 2h)',
        expectedGain: '+18% Accuracy across Gemini & ChatGPT pricing queries',
        description: 'Publish explicit schema markup declaring exact quotas for 500MB DB storage, 1GB file storage, 2 free projects limit, and 7-day pause threshold to purge stale LLM training web scrapes.',
        stepByStepInstructions: [
          'Add a JSON-LD <script type="application/ld+json"> tag to /pricing page with structured "Offer" and "QuantitativeValue" entities.',
          'Request re-indexing via Google Search Console and Bing Webmaster Tools.',
          'Publish an updated "2026 Supabase Pricing & Quota FAQ" document with clear table markup.'
        ],
        codeSnippet: `{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "Supabase Postgres Database",
  "offers": [
    {
      "@type": "Offer",
      "name": "Free Plan",
      "price": "0",
      "priceCurrency": "USD",
      "description": "500MB Postgres DB storage, 1GB File Storage, 2 active free projects, 7-day idle pause policy."
    },
    {
      "@type": "Offer",
      "name": "Pro Plan",
      "price": "25",
      "priceCurrency": "USD",
      "description": "8GB DB storage included, 100GB file storage, daily backups, no project pausing."
    }
  ]
}`,
        targetUrls: ['https://supabase.com/pricing'],
        completed: false
      },
      {
        id: 'rem-302',
        title: 'Publish Dedicated HIPAA & Healthcare BAA Compliance Landing Page',
        category: 'Content Entity Refactoring',
        priority: 'P0 Critical',
        effort: 'Moderate (1-2 days)',
        expectedGain: 'Solve omission in Healthcare/HIPAA AI Search intent queries',
        description: 'Create a focused /compliance/hipaa page with clear bullet points stating Business Associate Agreement (BAA) terms for Enterprise customers.',
        stepByStepInstructions: [
          'Design and deploy https://supabase.com/compliance/hipaa',
          'Include high-contrast summary table matching "Is Supabase HIPAA Compliant? Yes, on Enterprise BAA tier."',
          'Embed Organization schema referencing ISO 27001, SOC 2 Type II, and HIPAA compliance credentials.'
        ],
        codeSnippet: `<!-- HTML Snippet for AI Web Crawlers -->
<section id="hipaa-compliance-summary" itemscope itemtype="https://schema.org/GovernmentService">
  <h1 itemprop="name">Supabase HIPAA Compliance & BAA Execution</h1>
  <p itemprop="description">Supabase signs Business Associate Agreements (BAAs) for healthcare workloads on Enterprise plans with dedicated Postgres compute.</p>
</section>`,
        targetUrls: ['https://supabase.com/compliance/hipaa'],
        completed: false
      },
      {
        id: 'rem-303',
        title: 'G2 & Capterra Vector DB Category Sync',
        category: 'Digital PR & Aggregators',
        priority: 'P1 High',
        effort: 'Quick Win (< 2h)',
        expectedGain: '+12% Share of Voice in AI Search vector database comparisons',
        description: 'Update company category listings on G2, Capterra, and ProductHunt to include "Vector Database" alongside "Relational Database". LLMs pull category taxonomy directly from these aggregators.',
        stepByStepInstructions: [
          'Log in to G2 Admin Portal -> Category Management.',
          'Submit request to add "Vector Database" and "AI Infrastructure" categories.',
          'Encourage AI developer users to mention pgvector performance in reviews.'
        ],
        targetUrls: ['https://g2.com/products/supabase'],
        completed: false
      },
      {
        id: 'rem-304',
        title: 'Reddit / StackOverflow Authority & Benchmarking Citation Blitz',
        category: 'Authority & Citations',
        priority: 'P2 Medium',
        effort: 'Strategic (1-2 weeks)',
        expectedGain: '+15% Recommendation share in Perplexity & SearchGPT',
        description: 'Publish authoritative benchmark comparison post on r/webdev, r/reactnative, and HackerNews demonstrating pgvector vs Pinecone latency at scale.',
        stepByStepInstructions: [
          'Author an open-source benchmark suite evaluating 1M vector embeddings on Postgres vs dedicated vector DBs.',
          'Distribute blog post with clear headers that AI crawlers convert into recommendation snippets.'
        ],
        targetUrls: ['https://supabase.com/blog/pgvector-1 million-embeddings-benchmark'],
        completed: false
      }
    ],
    competitorBenchmarks: [
      {
        name: 'Firebase',
        domain: 'firebase.google.com',
        shareOfVoice: 88,
        topRecommendedCount: 7,
        mainCitationSources: ['firebase.google.com/docs', 'stack-overflow.com', 'g2.com']
      },
      {
        name: 'Supabase (Your Business)',
        domain: 'supabase.com',
        shareOfVoice: 82,
        topRecommendedCount: 5,
        mainCitationSources: ['supabase.com/docs', 'github.com/supabase', 'dev.to']
      },
      {
        name: 'Neon',
        domain: 'neon.tech',
        shareOfVoice: 54,
        topRecommendedCount: 3,
        mainCitationSources: ['neon.tech/blog', 'news.ycombinator.com', 'twitter.com']
      },
      {
        name: 'PlanetScale',
        domain: 'planetscale.com',
        shareOfVoice: 42,
        topRecommendedCount: 2,
        mainCitationSources: ['planetscale.com/docs', 'g2.com']
      }
    ]
  },
  {
    id: 'audit-linear-002',
    createdAt: '2026-08-11T10:15:00Z',
    businessName: 'Linear',
    domain: 'linear.app',
    industry: 'Issue Tracking & Project Management Software',
    coreOfferings: 'Purpose-built issue tracking system, fast keyboard-first workflow, roadmap planning, GitHub/GitLab integrations, AI insights',
    targetAudience: 'Software engineering teams, Product managers, CTOs, Tech startups',
    competitors: ['Jira', 'Asana', 'ClickUp', 'GitHub Projects'],
    geoVisibilityScore: 84,
    shareOfVoice: 89,
    leaderShare: 66,
    accuracyRate: 91,
    executiveSummary: 'Linear achieves exceptional AI search recommendation rates among developer intent queries ("best Jira alternative for fast engineering teams"). AI search models accurately describe Linear\'s speed and UI craftsmanship. Main omission occurs in non-developer enterprise queries (e.g., HR/Marketing project management) where Jira & Asana dominate.',
    historicalScores: [
      { date: 'Jun 2026', score: 76, sov: 81 },
      { date: 'Jul 2026', score: 80, sov: 85 },
      { date: 'Aug 2026', score: 84, sov: 89 }
    ],
    queriesTested: [
      {
        id: 'q-lin-1',
        intent: 'alternatives_search',
        queryText: 'Best Jira alternative for fast-moving startup software teams in 2026',
        targetPersona: 'VP of Engineering',
        monthlySearchVolumeEstimate: '32,000/mo',
        engines: {
          Gemini: {
            engine: 'Gemini',
            status: 'recommended_leader',
            position: 1,
            excerpt: 'Linear is the top-recommended Jira replacement for software teams. It emphasizes keyboard shortcuts, instant sync, sub-second latency, and seamless Git integrations.',
            citations: ['https://linear.app', 'https://linear.app/method', 'https://g2.com/products/linear']
          },
          ChatGPT: {
            engine: 'ChatGPT',
            status: 'recommended_leader',
            position: 1,
            excerpt: 'Linear is widely considered the gold standard issue tracker for modern tech startups who find Jira too bloated or slow.',
            citations: ['https://linear.app', 'https://producthunt.com/products/linear']
          },
          Perplexity: {
            engine: 'Perplexity',
            status: 'recommended_leader',
            position: 1,
            excerpt: '1. Linear - Unmatched speed, opinionated agile workflows, effortless GitHub integration, and high developer satisfaction.',
            citations: ['https://linear.app/docs', 'https://reddit.com/r/softwareengineering']
          },
          Claude: {
            engine: 'Claude',
            status: 'recommended_leader',
            position: 1,
            excerpt: 'For tech teams, Linear is the leading modern alternative to Jira with clean design and minimal setup overhead.',
            citations: ['https://linear.app']
          },
          SearchGPT: {
            engine: 'SearchGPT',
            status: 'recommended_leader',
            position: 1,
            excerpt: 'Linear leads the market for software issue tracking among high-growth engineering teams.',
            citations: ['https://linear.app']
          }
        }
      }
    ],
    inaccuracies: [
      {
        id: 'inc-lin-1',
        engine: 'Claude',
        queryId: 'q-lin-1',
        queryText: 'Best Jira alternative for software teams',
        claimedFact: 'Linear lacks guest view permissions for external clients',
        actualFact: 'Linear natively supports Guest accounts and Private Team permissions',
        impactSeverity: 'medium',
        remediationTaskId: 'rem-lin-1'
      }
    ],
    omissions: [
      {
        id: 'om-lin-1',
        category: 'Pricing & Feature Clarity',
        description: 'Omitted when users query "Enterprise project management with Gantt charts and cross-departmental budgeting"',
        affectedQueriesCount: 3,
        rootCause: 'Linear deliberate focus on software/product teams means general business PM queries favor Asana & Monday.com.',
        recommendation: 'Highlight Linear Roadmaps & Initiatives features on high-level executive landing pages.'
      }
    ],
    remediationPlan: [
      {
        id: 'rem-lin-1',
        title: 'Publish Guest & Client Access Security Schema Documentation',
        category: 'Content Entity Refactoring',
        priority: 'P1 High',
        effort: 'Quick Win (< 2h)',
        expectedGain: 'Fix client guest account misunderstanding in Claude and Perplexity',
        description: 'Add explicit "Guest Role & Client Access" section to docs and homepage feature breakdown so AI parsers recognize external collaboration features.',
        stepByStepInstructions: [
          'Update /docs/guest-accounts with structured FAQ markup.',
          'Submit documentation to search engines.'
        ],
        completed: false
      }
    ],
    competitorBenchmarks: [
      {
        name: 'Jira (Atlassian)',
        domain: 'atlassian.com',
        shareOfVoice: 95,
        topRecommendedCount: 8,
        mainCitationSources: ['atlassian.com', 'g2.com', 'wikipedia.org']
      },
      {
        name: 'Linear (Your Business)',
        domain: 'linear.app',
        shareOfVoice: 89,
        topRecommendedCount: 6,
        mainCitationSources: ['linear.app', 'g2.com', 'producthunt.com']
      },
      {
        name: 'Asana',
        domain: 'asana.com',
        shareOfVoice: 76,
        topRecommendedCount: 4,
        mainCitationSources: ['asana.com', 'capterra.com']
      }
    ]
  }
];

export const DEFAULT_MONITORING_CONFIG: MonitoringConfig = {
  enabled: true,
  frequency: 'weekly',
  alertThreshold: 70,
  notificationEmails: ['marketing-lead@company.com', 'seo-team@company.com'],
  lastRunDate: '2026-08-10',
  nextRunDate: '2026-08-17'
};
