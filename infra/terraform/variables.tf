variable "project_id" {
  description = "GCP project ID"
  type        = string
  default     = "cleanshot-493512"
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "us-central1"
}

variable "github_org" {
  description = "GitHub organisation or username"
  type        = string
  default     = "discountmedia"
}

variable "github_repo" {
  description = "GitHub repository name"
  type        = string
  default     = "CleanShot"
}
