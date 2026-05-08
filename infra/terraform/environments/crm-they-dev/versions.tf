terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  backend "s3" {
    bucket         = "openmercato-terraform-state-062648047691-eu-west-2"
    key            = "crm-they-dev/terraform.tfstate"
    region         = "eu-west-2"
    dynamodb_table = "openmercato-terraform-locks"
    encrypt        = true
  }
}
