import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import { authFetch } from '../../api/auth-fetch.js';

// ── Schemas ────────────────────────────────────────────────────────────────

const UpdateOnboardingContextParamsSchema = Type.Object({
  context: Type.Record(Type.String(), Type.Unknown(), {
    description: 'Key-value pairs to merge into the onboarding session context. ' +
      'Use keys: project_name, goal, repo, open_source, revenue_goal, target_customer, ' +
      'monetization, timeline, v1_scope, tech_preferences, summary. ' +
      'Only include keys where you have confirmed information.',
  }),
});
type UpdateOnboardingContextParams = Static<typeof UpdateOnboardingContextParamsSchema>;

const OnboardingHandoffParamsSchema = Type.Object({
  next_agent: Type.Union([
    Type.Literal('jim'),
    Type.Literal('eric'),
    Type.Literal('finn'),
    Type.Literal('yang'),
    Type.Literal('done'),
  ], {
    description: 'Which agent to hand off to next. Use "done" only when all agents have finished — this creates the project and kicks off the planning pipeline automatically.',
  }),
  summary: Type.String({
    description: 'One-sentence summary of the project as you understand it so far, to brief the next agent.',
  }),
  context: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
    description: 'Structured context extracted during this interview phase. Keys: project_name, goal, repo, open_source, revenue_goal, target_customer, monetization, timeline, v1_scope, tech_preferences.',
  })),
  conversation_highlights: Type.Optional(Type.Array(Type.String(), {
    description: '2-4 specific things the user said or notable moments from the conversation. '
      + 'NOT structured data (that goes in context) — conversational details that make the '
      + 'handoff feel seamless. E.g. "User mentioned they tried Firebase and hated vendor lock-in", '
      + '"They said they are a solo founder working evenings". The next agent will reference '
      + 'these in their greeting to show continuity.',
  })),
});
type OnboardingHandoffParams = Static<typeof OnboardingHandoffParamsSchema>;

const UpdateOnboardingLandingPageParamsSchema = Type.Object({
  html: Type.String({
    description: 'Complete, self-contained HTML for a high-converting landing page. '
      + 'Include all CSS inline (in a <style> tag). The HTML renders in a sandboxed iframe. '
      + 'This REPLACES the current landing page — include everything from the previous version plus your additions. '
      + 'Design guidelines: modern gradients, smooth typography (use Google Fonts via CDN), generous whitespace, '
      + 'clear call-to-action buttons, mobile-responsive (flexbox/grid), dark/light mode via prefers-color-scheme. '
      + 'Use REAL copy from the conversation — project name, value proposition, features, target customer — never lorem ipsum. '
      + 'Start simple (hero + tagline) and progressively add sections: features, social proof, pricing, FAQ, footer.',
  }),
  caption: Type.Optional(Type.String({
    description: 'Short caption describing the current state of the landing page (e.g. "Added features section", "Updated pricing tiers").',
  })),
});
type UpdateOnboardingLandingPageParams = Static<typeof UpdateOnboardingLandingPageParamsSchema>;

// ── Types ──────────────────────────────────────────────────────────────────

interface VoidDetails {}

export interface OnboardingToolsConfig {
  agentId: string;
  apiBaseUrl?: string;
}

// ── Tool factories ─────────────────────────────────────────────────────────

export function createOnboardingTools(config: OnboardingToolsConfig): AgentTool[] {
  const { agentId } = config;

  const getApiBase = () =>
    config.apiBaseUrl || process.env.DJINNBOT_API_URL || 'http://api:8000';

  return [
    // update_onboarding_context — update the live project profile sidebar
    {
      name: 'update_onboarding_context',
      description: 'Update the onboarding session context with newly extracted project information. ' +
        'Call this whenever you learn something concrete about the project (name, goal, tech stack, etc.). ' +
        'This updates the live "Project Profile" sidebar in real time. ' +
        'Recognised keys: project_name, goal, repo, open_source, revenue_goal, target_customer, ' +
        'monetization, timeline, v1_scope, tech_preferences, summary.',
      label: 'update_onboarding_context',
      parameters: UpdateOnboardingContextParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as UpdateOnboardingContextParams;
        const apiBase = getApiBase();
        const onboardingSessionId = process.env.ONBOARDING_SESSION_ID;
        if (!onboardingSessionId) {
          return { content: [{ type: 'text', text: 'No onboarding session ID available — context not updated.' }], details: {} };
        }
        try {
          const response = await authFetch(
            `${apiBase}/v1/onboarding/sessions/${onboardingSessionId}/context`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(p.context),
              signal: signal ?? undefined,
            },
          );
          if (!response.ok) {
            const text = await response.text();
            return { content: [{ type: 'text', text: `Context update failed: ${response.status} ${text}` }], details: {} };
          }
          const keys = Object.keys(p.context).join(', ');
          return { content: [{ type: 'text', text: `Onboarding context updated: ${keys}` }], details: {} };
        } catch (err) {
          return { content: [{ type: 'text', text: `Failed to update onboarding context: ${err}` }], details: {} };
        }
      },
    },

    // update_onboarding_landing_page — evolve the live landing page preview
    {
      name: 'update_onboarding_landing_page',
      description:
        'MANDATORY — you MUST call this tool during your onboarding phase. Updating the landing page is non-negotiable. ' +
        'Do NOT hand off without calling this at least once. ' +
        'Update the evolving landing page that the user sees in real time on the left panel. ' +
        'Call this EARLY and OFTEN — the user watches the landing page evolve as you learn about the project. ' +
        'You are building a high-converting, modern, beautiful landing page for the user\'s project. ' +
        'Write COMPLETE, self-contained HTML with inline CSS. The HTML renders in a sandboxed iframe. ' +
        'First call: create a simple hero section with the project name and tagline. ' +
        'Subsequent calls: progressively add sections (features, value prop, social proof, pricing, CTA, footer) ' +
        'as you learn more about the project. Use real copy from the conversation — never placeholder text. ' +
        'Each call REPLACES the full HTML — include everything from previous versions plus your additions. ' +
        'Design: modern gradients, smooth typography, generous whitespace, clear CTAs, mobile-responsive, ' +
        'dark/light mode support. Make it feel like a real, polished product page.',
      label: 'update_onboarding_landing_page',
      parameters: UpdateOnboardingLandingPageParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as UpdateOnboardingLandingPageParams;
        const apiBase = getApiBase();
        const onboardingSessionId = process.env.ONBOARDING_SESSION_ID;
        if (!onboardingSessionId) {
          return { content: [{ type: 'text', text: 'No onboarding session ID — landing page not updated.' }], details: {} };
        }
        try {
          const response = await authFetch(
            `${apiBase}/v1/onboarding/sessions/${onboardingSessionId}/landing-page`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ html: p.html, caption: p.caption }),
              signal: signal ?? undefined,
            },
          );
          if (!response.ok) {
            const text = await response.text();
            return { content: [{ type: 'text', text: `Landing page update failed: ${response.status} ${text}` }], details: {} };
          }
          return { content: [{ type: 'text', text: `Landing page updated${p.caption ? `: ${p.caption}` : ''}.` }], details: {} };
        } catch (err) {
          return { content: [{ type: 'text', text: `Failed to update landing page: ${err}` }], details: {} };
        }
      },
    },

    // onboarding_handoff — signal the orchestrator to switch to the next agent
    {
      name: 'onboarding_handoff',
      description:
        'Hand off the onboarding conversation to the next specialist agent. ' +
        'Call this when you have fully covered your area and built the memory graph for your phase. ' +
        'This stops your container and starts the next agent pre-seeded with everything gathered so far. ' +
        'DO NOT call complete() — call this instead to hand off.',
      label: 'onboarding_handoff',
      parameters: OnboardingHandoffParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as OnboardingHandoffParams;
        const apiBase = getApiBase();
        const onboardingSessionId = process.env.ONBOARDING_SESSION_ID;

        console.log(`[onboarding_handoff] ${agentId} → ${p.next_agent}: "${p.summary}" (sessionId=${onboardingSessionId})`);

        if (!onboardingSessionId) {
          console.error('[onboarding_handoff] ONBOARDING_SESSION_ID env var is not set — handoff cannot proceed!');
          return {
            content: [{ type: 'text', text: 'Handoff failed: no onboarding session ID available (ONBOARDING_SESSION_ID not set).' }],
            details: {},
          };
        }

        try {
          const response = await authFetch(
            `${apiBase}/v1/onboarding/sessions/${onboardingSessionId}/handoff`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                next_agent_id: p.next_agent,
                summary: p.summary,
                context_update: p.context,
                from_agent_id: agentId,
                conversation_highlights: p.conversation_highlights,
              }),
              signal: signal ?? undefined,
            },
          );
          if (!response.ok) {
            const text = await response.text();
            console.error(`[onboarding_handoff] API call failed: ${response.status} ${text}`);
            return {
              content: [{ type: 'text', text: `Handoff API call failed: ${response.status} ${text}` }],
              details: {},
            };
          }
          console.log(`[onboarding_handoff] Handoff to ${p.next_agent} accepted by API`);
          return {
            content: [{ type: 'text', text: `Handing off to ${p.next_agent}. ${p.summary} The next agent will continue from here.` }],
            details: {},
          };
        } catch (err) {
          console.error(`[onboarding_handoff] Fetch failed:`, err);
          return {
            content: [{ type: 'text', text: `Handoff failed: ${err}` }],
            details: {},
          };
        }
      },
    },
  ];
}
