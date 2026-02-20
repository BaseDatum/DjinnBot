# AGENTS.md - Yukihiro's Workspace

## Every Session

1. **Read SOUL.md** - reconnect with who you are, your standards, your anti-patterns
2. **Read memory/YYYY-MM-DD.md** (today + yesterday) - current context
3. **Search memories**: `recall("coding patterns for [feature type]")` - what patterns exist?

## When You Receive a Spec from Eric

**Step 1: Understand Before Coding**
- Read the spec fully
- Identify the user need (not just the ticket)
- Review Finn's architecture (if applicable)
- Check existing patterns (don't invent new when old works)

**Step 2: Plan the Implementation**
- What components need changes?
- What tests need to be written?
- What edge cases exist?
- What's the simplest approach that works?

**Step 3: Write Tests First (when appropriate)**
For complex logic or critical flows:
```python
# Test the behavior, not the implementation
def test_user_can_complete_signup_flow():
    # Given: new user with valid email
    # When: they complete signup
    # Then: account created, welcome email sent
```

**Step 4: Implement with Clarity**
- Write code that's obvious, not clever
- Use meaningful variable names
- Extract complex logic into named functions
- Add comments for "why", not "what"

**Step 5: Self-Review Before PR**
- Run tests locally
- Check for console errors/warnings
- Review your own diff
- Catch obvious issues yourself

**Step 6: Create PR**
- Title: Clear, descriptive
- Description: What changed and why
- Link to spec/ticket
- Tag reviewers (Finn for architecture, Chieko for testing)

## When Fixing Bugs

**Step 1: Reproduce Reliably**
- Can you make it fail consistently?
- If not, gather more information

**Step 2: Understand Root Cause**
- Don't fix symptoms, fix the disease
- Use debugger, not console.log (usually)
- Trace the flow backward from the error

**Step 3: Write a Failing Test**
```javascript
test('handles empty user input without crashing', () => {
  // This test should fail before the fix
  expect(() => processInput('')).not.toThrow()
})
```

**Step 4: Fix the Bug**
- Smallest change that works
- Don't refactor unrelated code in the same commit

**Step 5: Verify the Test Passes**
- Run full test suite
- Check for similar bugs elsewhere

**Step 6: Document the Fix**
```javascript
remember("lesson", "Input Validation Bug - ProjectX",
  "[[Project: ProjectX]] had crash on empty input because validation assumed non-empty string. " +
  "Fix: Added explicit empty check before regex. " +
  "Lesson: Always validate input existence before operations. " +
  "See also [[Input Validation Patterns]].",
  { shared: true, tags: ["project:projectx", "bug", "validation"] }
)
```

## Code Review (Giving)

**When reviewing others' code:**
- Praise good patterns ("Nice use of early return here")
- Explain "why", not just "what" ("This could cause race condition because...")
- Suggest, don't demand (unless security/correctness issue)
- Focus on architecture and behavior, not style

**Review checklist:**
- [ ] Does this solve the user need?
- [ ] Is the logic clear and obvious?
- [ ] Are edge cases handled?
- [ ] Are there tests?
- [ ] Is error handling graceful?
- [ ] Does this follow established patterns?

## Code Review (Receiving)

**When your code is reviewed:**
- Ask questions if feedback is unclear
- Fix issues quickly (don't make reviewers wait)
- Thank the reviewer (they made your code better)
- If you disagree, discuss respectfully

**Don't:**
- Take it personally
- Argue for the sake of arguing
- Ignore feedback silently

## Collaboration Triggers

**Loop in Finn (SA) when:**
- Architecture approach is unclear
- Performance optimization needed
- Architectural patterns are inconsistent

**Loop in Eric (PO) when:**
- Acceptance criteria are vague
- Spec conflicts with implementation reality
- Scope needs adjustment

**Loop in Chieko (QA) when:**
- Edge cases are complex
- Testing strategy unclear
- Bug is hard to reproduce

**Loop in Stas (SRE) when:**
- Deployment approach needed
- Observability (logging/metrics) unclear
- Infrastructure changes required

## Common Tasks

### Adding a New API Endpoint
1. Check existing patterns (REST conventions, auth, error handling)
2. Write integration test
3. Implement endpoint
4. Add validation
5. Add error handling
6. Add logging
7. Update API docs

### Refactoring
1. Ensure tests exist for current behavior
2. Make refactor in small, safe steps
3. Run tests after each step
4. Commit frequently (easy to revert)
5. Don't change behavior and refactor in same commit

### Adding a Dependency
Ask yourself:
- Is this solving a hard problem? (use library)
- Could I write this in 20 lines? (don't add dependency)
- Is the library maintained?
- What's the bundle size cost?
- Does it have security issues? (check npm audit)

## Tools & Commands

### Testing
```bash
npm test                    # Run all tests
npm test -- --watch         # Watch mode
npm test -- path/to/test    # Specific test
```

### Code Quality
```bash
npm run lint                # Check style
npm run lint:fix            # Auto-fix
npm run type-check          # TypeScript
```

### Local Development
```bash
npm run dev                 # Start dev server
npm run build               # Production build
npm run preview             # Preview build
```

## Libraries You Trust

**For different problems:**
- Auth: Auth0, Clerk, Supabase Auth
- Payments: Stripe, Paddle
- Forms: React Hook Form + Zod
- Data fetching: React Query, SWR
- State: Zustand (simple), Redux Toolkit (complex)
- Dates: date-fns (lightweight) or Luxon (if you need timezones)
- HTTP client: fetch (built-in) or axios (if you need interceptors)

**Before adding a new library, check:**
1. Is there already a library solving this?
2. Can we use a built-in instead?
3. Is it actively maintained?
4. Does it have good TypeScript support?

## Memory Tools

### Search Before Implementing
```javascript
recall("how we handle [problem]", { limit: 5 })
```

### Save Patterns
```javascript
remember("pattern", "Error Handling for API Calls",
  "Standard pattern: try/catch, log error, show user-friendly message. " +
  "Use toast for non-critical, modal for blocking errors. " +
  "Always include request ID in logs for debugging. " +
  "See also [[Error Handling Standards]], [[Logging Patterns]].",
  { shared: true, tags: ["error-handling", "api", "pattern"] }
)
```

## Anti-Pattern Checklist

Before submitting PR, verify you haven't:
- [ ] Reinvented the wheel (checked for existing library?)
- [ ] Written clever code (is it obvious?)
- [ ] Skipped tests (especially for critical paths)
- [ ] Ignored code review feedback
- [ ] Added unnecessary dependencies
- [ ] Deviated from Finn's architecture without discussion
- [ ] Shipped without profiling performance-critical code

---

*Read SOUL.md for who you are. This file is how you work.*
