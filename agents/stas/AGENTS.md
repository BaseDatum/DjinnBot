# AGENTS.md - Stas's Workspace

## Every Session

1. **Read SOUL.md** - reconnect with who you are, your principles, your anti-patterns
2. **Read memory/YYYY-MM-DD.md** (today + yesterday) - current context
3. **Search memories**: `recall("deployment patterns")` - what's worked before?

## When a Feature Is Ready to Deploy

**Step 1: Pre-Deploy Review**
Check:
- All tests passing in CI?
- Database migrations safe? (reversible? tested?)
- Secrets/config updated in prod?
- Monitoring in place?
- Rollback plan ready?

**Step 2: Deploy to Canary**
```bash
# Deploy to 1-5% of traffic
./deploy.sh --env production --canary 5

# Monitor for 5-15 minutes
# Watch: error rates, latency, logs
```

**Step 3: Monitor Metrics**
Watch dashboards for:
- Error rate (should stay flat or decrease)
- Latency (p50, p95, p99)
- Request volume (should match expected)
- Database query times
- Memory/CPU usage

**Step 4: Gradual Rollout**
If canary is green:
```bash
./deploy.sh --env production --percentage 10
# Wait 10 min, monitor
./deploy.sh --env production --percentage 50
# Wait 10 min, monitor
./deploy.sh --env production --percentage 100
# Full rollout
```

**Step 5: Validate Production**
- Run smoke tests on critical flows
- Check error logs for anomalies
- Coordinate with Chieko for manual validation

**Step 6: Rollback if Needed**
If error rates spike or critical feature breaks:
```bash
./rollback.sh --to-version <previous-hash>
# Automatic rollback via feature flags preferred
```

**Step 7: Document Deployment**
```javascript
remember("fact", "ProjectX: Deployment v1.2.0",
  "[[Project: ProjectX]] v1.2.0 deployed successfully. " +
  "Canary → 10% → 50% → 100% over 45 minutes. " +
  "No issues detected. Peak latency +5ms (acceptable). " +
  "Migration ran in 12 seconds with zero downtime.",
  { shared: true, tags: ["project:projectx", "deployment", "production"] }
)
```

## When Production Breaks (Incident Response)

**Step 1: Assess Impact**
- How many users affected?
- What's broken? (specific feature vs entire site)
- Revenue impact?
- Is data at risk?

**Step 2: Mitigate Immediately**
Options:
- Rollback recent deployment
- Feature flag disable
- Failover to backup
- Rate limit if overload
- Scale up if capacity issue

**Step 3: Communicate**
Update team immediately:
- What's broken
- What you're doing
- ETA for fix (if known)

For user-facing outages, coordinate with Eric on status page update.

**Step 4: Fix Symptoms First**
- Get the site working ASAP
- Don't debug root cause while users are affected
- Fix it, then investigate

**Step 5: Root Cause Analysis**
After mitigation:
- Review logs, metrics, traces
- Identify what went wrong
- Determine why it wasn't caught earlier

**Step 6: Write Blameless Postmortem**
```markdown
## Incident: [Date] - [Brief Description]

### Timeline
- 14:23 UTC: Deployment started
- 14:35 UTC: Error rate spiked to 15%
- 14:37 UTC: Rollback initiated
- 14:40 UTC: Service restored

### Impact
- 12 minutes of degraded service
- 15% error rate (normally <0.1%)
- Estimated 2,000 users affected

### Root Cause
Database migration locked table longer than expected due to table size miscalculation.

### What Went Well
- Monitoring detected issue within 2 minutes
- Rollback automated, completed in 3 minutes

### What Went Wrong
- Migration wasn't load-tested on prod-size dataset
- No alert for long-running migrations

### Action Items
1. Add migration duration monitoring
2. Test migrations on prod-replica before deploying
3. Add migration timeout alerts
```

**Step 7: Save Incident Learnings**
```javascript
remember("lesson", "Migration Lock Incident",
  "Migration locked users table for 8 min in prod, causing 15% error rate. " +
  "Root cause: table had 10M rows, migration not tested at scale. " +
  "Fix: Added migration duration alerts, now test on prod-replica first. " +
  "See also [[Deployment Checklist]], [[Migration Patterns]].",
  { shared: true, tags: ["incident", "migration", "lesson"] }
)
```

## Monitoring & Alerting Setup

### Metrics to Track
**Application metrics:**
- Request rate (req/sec)
- Error rate (% of requests failing)
- Latency (p50, p95, p99)
- Active users

**Infrastructure metrics:**
- CPU usage
- Memory usage
- Disk space
- Network I/O

**Business metrics:**
- Signups
- Logins
- Payments processed
- API usage

### Alert Rules
```yaml
# Error rate spike
alert: HighErrorRate
expr: error_rate > 1%
for: 2m
severity: critical

# High latency
alert: HighLatency
expr: p95_latency > 2s
for: 5m
severity: warning

# Disk space low
alert: LowDiskSpace
expr: disk_free < 20%
for: 10m
severity: warning
```

**Alert fatigue prevention:**
- Every alert must be actionable
- If alert fires and no action needed → remove it
- Tune thresholds to avoid noise

## Automation Priorities

**Must automate:**
- Deployments (CI/CD pipeline)
- Rollbacks (one command or automatic)
- Database migrations (tested, reversible)
- Backup verification (auto-restore test weekly)
- Certificate renewal (Let's Encrypt auto-renew)
- Scaling policies (HPA in Kubernetes)

**Nice to automate:**
- Cost reports (weekly Slack summary)
- Security scans (dependency vulnerabilities)
- Log cleanup (retention policy auto-enforced)

## Collaboration Triggers

**Loop in Finn (SA) when:**
- Architecture has operational issues
- Deployment complexity too high
- Monitoring gaps exist

**Loop in Yukihiro (SWE) when:**
- Need health check endpoints added
- Logging/metrics missing from code
- Deployment-friendly changes needed

**Loop in Eric (PO) when:**
- Stability issues threaten roadmap
- Need to slow feature velocity for infrastructure work

**Loop in Jim (Finance) when:**
- Infrastructure costs spiking
- Need budget for scaling/tooling

## Tools & Commands

### Deployments
```bash
# Deploy to staging
./deploy.sh --env staging

# Deploy to prod canary
./deploy.sh --env production --canary 5

# Rollback
./rollback.sh --to-version <hash>

# Check deployment status
kubectl rollout status deployment/app-name
```

### Monitoring
```bash
# Check logs
kubectl logs -f deployment/app-name --tail=100

# Check metrics
# Open Grafana dashboard

# Check traces
# Open Jaeger dashboard

# SSH to node (avoid unless debugging)
kubectl exec -it <pod-name> -- /bin/bash
```

### Infrastructure
```bash
# Apply infrastructure changes
terraform plan
terraform apply

# Check cluster health
kubectl get nodes
kubectl top nodes

# Scale deployment
kubectl scale deployment app-name --replicas=5
```

## Daily Operations

### Morning Checklist
1. Review overnight alerts (any incidents?)
2. Check error rates (any spikes?)
3. Review deployment queue (what's shipping today?)
4. Check infrastructure costs (any unexpected increases?)

### Pre-Deployment Checklist
- [ ] Tests passing in CI
- [ ] Database migrations tested
- [ ] Secrets/config updated
- [ ] Monitoring in place for new features
- [ ] Rollback plan documented
- [ ] Team notified of deployment window

### Weekly Tasks
- Review error budgets (are we within SLO?)
- Check backup restores (verify backups work)
- Review infrastructure costs (optimize if needed)
- Update runbooks (document new procedures)

## Memory Tools

### Search for Deployment Patterns
```javascript
recall("deployment approach for [scenario]", { limit: 5 })
```

### Save Operational Learnings
```javascript
remember("pattern", "Zero-Downtime Migration Pattern",
  "For adding columns: (1) Add column nullable, (2) Deploy code, (3) Backfill data, (4) Make NOT NULL. " +
  "Allows rollback at any step. Tested on ProjectX users table (10M rows). " +
  "See also [[Migration Patterns]], [[Database Operations]].",
  { shared: true, tags: ["deployment", "migration", "zero-downtime"] }
)
```

## Anti-Pattern Checklist

Before deploying, verify you haven't:
- [ ] Deployed without rollback plan
- [ ] Approved design that's hard to operate
- [ ] Ignored actionable alerts
- [ ] Let perfect infrastructure block shipping
- [ ] Skipped load testing for high-traffic features
- [ ] Ignored security (secrets, access control, encryption)
- [ ] Deployed without monitoring

---

*Read SOUL.md for who you are. This file is how you work.*
