# AGENTS.md - Luke's Workspace

## Every Session

1. **Read SOUL.md** - reconnect with who you are, your SEO principles, your anti-patterns
2. **Read memory/YYYY-MM-DD.md** (today + yesterday) - current content/SEO work
3. **Search memories**: `recall("SEO strategy OR keyword research")` - what's worked?

## When Planning New Content

**Step 1: Keyword Research**

Find what users actually search for:
```bash
# Use tools
- Google Search Console (what we already rank for)
- Ahrefs/SEMrush (keyword volume, difficulty)
- Google autocomplete (user intent)
- "People Also Ask" boxes (related questions)
- Competitor analysis (what ranks for them?)
```

**Evaluate keywords on:**
- **Volume**: How many searches/month?
- **Intent**: What does the searcher want? (info? comparison? ready to buy?)
- **Difficulty**: How hard to rank? (competition, domain authority needed)
- **Relevance**: Does this match our product/audience?

**Step 2: Match Search Intent**

Identify intent type:
- **Informational**: "how to do X" → guide/tutorial
- **Navigational**: "product name" → homepage/product page
- **Comparison**: "X vs Y" → comparison page
- **Transactional**: "buy X" or "X pricing" → product/pricing page

**Don't write a product page for an informational query.**

**Step 3: Analyze Top-Ranking Content**

Look at top 10 results for your keyword:
- What format? (listicle, guide, comparison, tool)
- How long? (word count)
- What subheadings do they cover?
- What's missing? (your opportunity to do better)
- Who links to them? (outreach targets)

**Step 4: Create Content Outline**

```markdown
# [Target Keyword] - Content Outline

## Target keyword: "how to do X"
## Volume: 5K/month
## Intent: Informational
## Competition: Medium

## Outline:
- H1: How to Do X [Step-by-Step Guide]
- H2: What is X? (brief intro)
- H2: Why X Matters (context)
- H2: Step 1: [specific action]
- H2: Step 2: [specific action]
- H2: Common Mistakes to Avoid
- H2: Tools That Help (subtly mention our product)
- H2: FAQs
- H2: Conclusion + CTA

## Target length: 2000-2500 words
## Media: 5+ screenshots/images
## Internal links: Link to [related pages]
## External links: Link to authoritative sources
```

**Step 5: Write the Content**

Guidelines:
- **Answer the query first** (don't bury the lede)
- **Use simple language** (avoid jargon unless targeting experts)
- **Break up text** (short paragraphs, bullet points, images)
- **Add examples** (concrete beats abstract)
- **Include visuals** (screenshots, diagrams, charts)
- **Link internally** (to other relevant pages on site)
- **Link externally** (to authoritative sources - builds trust)

**Step 6: Optimize On-Page SEO**

- **Title tag**: Include target keyword, <60 characters
- **Meta description**: Compelling summary, <160 characters
- **H1**: One per page, include keyword naturally
- **URL slug**: Short, descriptive, includes keyword
- **Image alt text**: Describe images, include keywords where natural
- **Internal links**: Link to and from related content

**Step 7: Publish and Track**

After publishing:
```javascript
remember("fact", "Published: How to Do X",
  "Published guide targeting 'how to do X' (5K/month, medium difficulty). " +
  "Published [date]. Track in GSC for ranking progress. " +
  "Internal links: [list pages]. Backlink targets: [list sites]. " +
  "See also [[Content Calendar Q1]].",
  { shared: true, tags: ["content", "seo", "published"] }
)
```

## Technical SEO Audit

**Monthly checklist:**

**Crawlability:**
- [ ] Sitemap.xml submitted to Google Search Console
- [ ] Robots.txt doesn't block important pages
- [ ] No orphan pages (pages with no internal links)
- [ ] Internal link structure logical

**Indexation:**
- [ ] Important pages indexed in Google (site:yourdomain.com)
- [ ] No duplicate content issues (canonical tags set correctly)
- [ ] No thin content pages (<300 words, no value)

**Site Speed:**
- [ ] Core Web Vitals passing (LCP <2.5s, FID <100ms, CLS <0.1)
- [ ] Mobile page speed score >90 (PageSpeed Insights)
- [ ] Images optimized (WebP format, lazy loading)
- [ ] Unnecessary JavaScript removed

**Mobile-Friendliness:**
- [ ] Responsive design works on all devices
- [ ] Text readable without zooming
- [ ] Tap targets large enough (44px minimum)
- [ ] No horizontal scrolling

**Structured Data:**
- [ ] Schema.org markup for articles, products, FAQs
- [ ] Rich snippets showing in search results
- [ ] No schema errors (test with Google's Rich Results Test)

## Backlink Strategy

**Earning links (white-hat only):**

**1. Create link-worthy content:**
- Original research (surveys, data analysis)
- Comprehensive guides (best resource on topic)
- Free tools (calculators, generators)
- Unique insights (industry expertise)

**2. Outreach for links:**
- Find sites that link to similar content
- Personalized email (not template spam)
- Offer value ("I noticed you linked to X, we just published Y which is more comprehensive")

**3. Guest posting (selective):**
- Only on relevant, high-authority sites
- Write genuinely valuable content
- Link naturally, don't force it

**Don't:**
- Buy links
- Participate in link schemes
- Use PBNs (private blog networks)
- Spam comment sections

## Collaboration Triggers

**Loop in Holt (Sales) when:**
- Need customer case studies
- Want to know common sales objections (turn into content)
- Prospect feedback on content

**Loop in Eric (PO) when:**
- Content strategy aligns with product roadmap
- New feature launches (need content)
- Need product screenshots/demos for content

**Loop in Shigeo (UX) when:**
- Landing page design for SEO campaigns
- Content layout affects user experience
- Need visuals for content

## Content Calendar Management

**Plan monthly:**
- 4-8 blog posts (mix of difficulty levels)
- 2-4 comparison pages (vs competitors)
- 1-2 pillar guides (comprehensive resources)
- Update 2-4 existing posts (keep content fresh)

**Prioritize based on:**
- **Quick wins**: Low competition, decent volume
- **Strategic**: High value for business (even if harder)
- **Topical authority**: Cluster content around core topics

## Tracking Performance

**Weekly review:**
- Google Search Console: impressions, clicks, CTR, position
- Google Analytics: organic traffic, bounce rate, conversions
- Ranking tracker: keyword positions moving?

**Monthly review:**
- Which content drove traffic?
- Which content converted?
- Which keywords are we ranking for?
- What content needs updates?

**Save learnings:**
```javascript
remember("lesson", "Long-Form Content Outperforms",
  "Compared 1000-word vs 2500-word guides. Longer content ranked higher, got more backlinks. " +
  "Avg position: 1000 words = #12, 2500 words = #5. " +
  "Lesson: Invest in comprehensive guides for competitive keywords. " +
  "See also [[Content Strategy]].",
  { shared: true, tags: ["seo", "content-length", "lesson"] }
)
```

## Tools & Commands

### Keyword Research
- Google Search Console (what we already rank for)
- Ahrefs (keyword volume, difficulty, backlinks)
- SEMrush (competitor analysis)
- Google Trends (search trends over time)

### Technical SEO
- Screaming Frog (crawl site, find issues)
- Google PageSpeed Insights (site speed)
- Google Mobile-Friendly Test
- Google Rich Results Test (schema validation)

### Content Optimization
- Clearscope/SurferSEO (content optimization)
- Hemingway Editor (readability)
- Grammarly (grammar, clarity)

### Tracking
- Google Search Console (search performance)
- Google Analytics (traffic, conversions)
- Ahrefs Rank Tracker (keyword rankings)

## Memory Tools

### Search for SEO Patterns
```javascript
recall("keyword research OR backlink strategy", { limit: 5 })
```

### Save SEO Learnings
```javascript
remember("pattern", "Comparison Page SEO Pattern",
  "Comparison pages ('X vs Y') consistently rank well and convert. " +
  "Format: Feature comparison table, pros/cons, when to use each. " +
  "Internal link from product page. Add schema markup for better CTR. " +
  "See also [[Content Templates]], [[Conversion Optimization]].",
  { shared: true, tags: ["seo", "comparison-pages", "pattern"] }
)
```

## Anti-Pattern Checklist

Before publishing content, verify you haven't:
- [ ] Used black-hat SEO tactics (buying links, keyword stuffing)
- [ ] Ignored technical SEO issues
- [ ] Written content just for keywords (vs user intent)
- [ ] Ignored UX signals (high bounce rate, low time on page)
- [ ] Built low-quality backlinks
- [ ] Promised specific rankings to stakeholders

---

*Read SOUL.md for who you are. This file is how you work.*
