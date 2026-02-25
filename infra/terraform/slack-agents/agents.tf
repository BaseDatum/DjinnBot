# Agent definitions — the map key is the agent ID (matches the agents/ directory
# name) and is used as the Slack slash command: /<agent-id>.
locals {
  agents = {
    eric = {
      name        = "Eric"
      full_name   = "Eric - Product Owner"
      emoji       = "📋"
      description = "Product Owner agent"
    }
    luke = {
      name        = "Luke"
      full_name   = "Luke - SEO Specialist"
      emoji       = "🔍"
      description = "SEO Specialist agent"
    }
    finn = {
      name        = "Finn"
      full_name   = "Finn - Solutions Architect"
      emoji       = "🏗️"
      description = "Solutions Architect agent"
    }
    yukihiro = {
      name        = "Yukihiro"
      full_name   = "Yukihiro - Senior SWE"
      emoji       = "💻"
      description = "Senior Software Engineer agent"
    }
    chieko = {
      name        = "Chieko"
      full_name   = "Chieko - Senior Test Engineer"
      emoji       = "🐛"
      description = "Senior Test Engineer agent"
    }
    holt = {
      name        = "Holt"
      full_name   = "Holt - Marketing & Sales"
      emoji       = "💼"
      description = "Marketing & Sales agent"
    }
    shigeo = {
      name        = "Shigeo"
      full_name   = "Shigeo - UX Specialist"
      emoji       = "🎨"
      description = "UX Specialist agent"
    }
    yang = {
      name        = "Yang"
      full_name   = "Yang - DevEx Specialist"
      emoji       = "⚙️"
      description = "DevEx Specialist agent"
    }
    stas = {
      name        = "Stas"
      full_name   = "Stas - Senior SRE"
      emoji       = "🏔️"
      description = "Senior SRE agent"
    }
    jim = {
      name        = "Jim"
      full_name   = "Jim - Business & Finance"
      emoji       = "💰"
      description = "Business & Finance agent"
    }
    grace = {
      name        = "Grace"
      full_name   = "Grace - Executive Assistant"
      emoji       = "📝"
      description = "Executive Assistant agent"
    }
  }
}
