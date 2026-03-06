terraform {
  required_providers {
    slackapp = {
      source  = "yumemi-inc/slackapp"
      version = "~> 0.2.4"
    }
  }
}

provider "slackapp" {
  app_configuration_token = var.slack_app_config_token
  refresh_token           = var.slack_refresh_token
}

variable "slack_app_config_token" {
  type      = string
  sensitive = true
}

variable "slack_refresh_token" {
  type      = string
  sensitive = true
}
