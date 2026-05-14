# CleanShot — Terraform Infrastructure
# GCP Project: cleanshot-493512
# Region: us-central1
# TODO: implement per Phase 4 Playbook v4.2

terraform {
  required_version = ">= 1.7"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
  # TODO: configure remote backend (GCS bucket for state)
  # backend "gcs" {
  #   bucket = "cleanshot-terraform-state"
  #   prefix = "terraform/state"
  # }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
