# Slack Agents Terraform

Creates individual Slack apps for each Djinnbot agent.

## Agents

| Agent | Full Name | Slash Command |
|-------|-----------|---------------|
| Eric | Product Owner | /eric |
| Luke | SEO Specialist | /luke |
| Finn | Solutions Architect | /finn |
| Yukihiro | Senior SWE | /yuki |
| Chieko | Test Engineer | /chie |
| Holt | Marketing & Sales | /holt |
| Shigeo | UX Specialist | /shig |
| Yang | DevEx Specialist | /yang |
| Stas | Senior SRE | /stas |
| Jim | Business & Finance | /jim |
| Grace | Executive Assistant | /grace |

## Setup

1. Get configuration tokens from https://api.slack.com/apps
2. Copy `terraform.tfvars.example` to `terraform.tfvars`
3. Fill in your tokens
4. Run:
   ```bash
   terraform init
   terraform plan
   terraform apply
   ```

## After Creation

After apps are created, you need to:
1. Install each app to the workspace
2. Get the bot token (xoxb-...) and app token (xapp-...) for each
3. Update set env vars or put tokens in UI for each agent.
