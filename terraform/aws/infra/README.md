# AWS Infrastructure Design

---

## Table of Contents
1. [Executive Summary](#executive-summary)
2. [Architecture Overview](#architecture-overview)
3. [Network Design](#network-design)
4. [Security Model](#security-model)
5. [Cost Considerations](#cost-considerations)
6. [Access Patterns](#access-patterns)

---

## 1. Executive Summary

This document defines the infrastructure-as-code design for deploying a production/development-grade Amazon EKS cluster with DocumentDB for the Walt.id Enterprise application.

### Key Features
- **High Availability**: Multi-AZ deployment across 3 availability zones
- **Security**: Private EKS cluster with restricted public endpoint access via CIDR allow-lists
- **Scalability**: Managed node groups with Cluster Autoscaler
- **Observability**: CloudWatch Container Insights enabled by default
- **Database**: Multi-AZ DocumentDB cluster with MongoDB compatibility
- **Object Storage**: Public read-only S3 bucket, disabled by default
- **Load Balancing**: Ingress NGINX exposed via internet-facing NLB
- **Encryption**: AWS managed KMS encryption for EKS secrets

### File Structure
```
terraform/aws/
├── providers.tf              # Terraform and provider configurations
├── data.tf                   # Dynamic data sources (AZs, OIDC)
├── variables.tf              # Input variables
├── main.tf                   # EKS cluster, node groups, add-ons
├── vpc.tf                    # VPC, subnets, NAT gateways
├── documentdb.tf             # DocumentDB cluster and security
├── iam.tf                    # IAM roles and policies
├── helm.tf                   # Helm chart deployments
├── s3-credential-status.tf   # S3 bucket for credential status publishing
├── outputs.tf                # Output values
└── env/
    ├── dev.tfvars            # Development environment
    ├── prod.tfvars           # Production environment
    └── README.md             # Deployment guide
```

---

## 2. Architecture Overview

### High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    Internet / Your Office VPN                    │
│                   (CIDR: 203.0.113.0/24 example)                 │
└───────────────────────────────┬──────────────────────────────────┘
                                │
                                │ kubectl via public endpoint (restricted)
                                │
┌───────────────────────────────▼──────────────────────────────────┐
│                 AWS Region (e.g., eu-north-1)                    │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │            Network Load Balancer (Regional)                │  │
│  └───────────────┬───────────────┬───────────────┬────────────┘  │
│                  │               │               │               │
│  ┌───────────────▼───────────────────────────────────────────┐   │
│  │                    VPC (10.0.0.0/16)                      │   │
│  │                                                           │   │
│  │  ┌─────────────────────────────────────────────────────┐  │   │
│  │  │                Availability Zone 1                  │  │   │
│  │  │                                                     │  │   │
│  │  │  ┌──────────────┐      ┌─────────────────────────┐  │  │   │
│  │  │  │ PublicSubnet │      │      Private Subnet     │  │  │   │
│  │  │  │ 10.0.0.0/20  │      │      10.0.16.0/20       │  │  │   │
│  │  │  │              │      │                         │  │  │   │
│  │  │  │ - NAT GW *   │      │ - EKS Worker Nodes      │  │  │   │
│  │  │  │ - IGW        │      │ - Pods                  │  │  │   │
│  │  │  │ - NLB Node   │      │ - DocumentDB            │  │  │   │
│  │  │  └───────┬──────┘      └──────────┬──────────────┘  │  │   │
│  │  │          │                        │                 │  │   │
│  │  ├──────────┼────────────────────────┼─────────────────┤  │   │
│  │  │                Availability Zone 2                  │  │   │
│  │  │                                                     │  │   │
│  │  │  ┌──────────────┐      ┌─────────────────────────┐  │  │   │
│  │  │  │ PublicSubnet │      │      Private Subnet     │  │  │   │
│  │  │  │ 10.0.32.0/20 │      │      10.0.48.0/20       │  │  │   │
│  │  │  │              │      │                         │  │  │   │
│  │  │  │ - NAT GW(opt)│      │ - EKS Worker Nodes      │  │  │   │
│  │  │  │ - IGW        │      │ - Pods                  │  │  │   │
│  │  │  │ - NLB Node   │      │ - DocumentDB            │  │  │   │
│  │  │  └───────┬──────┘      └──────────┬──────────────┘  │  │   │
│  │  │          │                        │                 │  │   │
│  │  ├──────────┼────────────────────────┼─────────────────┤  │   │
│  │  │                Availability Zone 3                  │  │   │
│  │  │                                                     │  │   │
│  │  │  ┌──────────────┐      ┌─────────────────────────┐  │  │   │
│  │  │  │ PublicSubnet │      │      Private Subnet     │  │  │   │
│  │  │  │ 10.0.64.0/20 │      │      10.0.80.0/20       │  │  │   │
│  │  │  │              │      │                         │  │  │   │
│  │  │  │ - NAT GW(opt)│      │ - EKS Worker Nodes      │  │  │   │
│  │  │  │ - IGW        │      │ - Pods                  │  │  │   │
│  │  │  │ - NLB Node   │      │ - DocumentDB            │  │  │   │
│  │  │  └──────────────┘      └─────────────────────────┘  │  │   │
│  │  └─────────────────────────────────────────────────────┘  │   │
│  │                                                           │   │
│  │  * NLB is regional and deploys nodes in each AZ subnet    │   │
│  │  * IGW is VPC-wide and accessible by each public subnet   │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                        CloudWatch                          │  │
│  │       - Container Insights                                 │  │
│  │       - Control Plane Logs                                 │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### Traffic Flow

#### 1. External User → Application
```
Internet User
    ↓ (HTTPS)
Network Load Balancer
    ↓
Nginx Ingress Controller (Private Subnet)
    ↓
Application Service (Private Subnet)
    ↓
Application Pods (Private Subnet)
    ↓
DocumentDB (Private Subnet)
```

Ingress optimization notes:
- `externalTrafficPolicy = Local` is set on the Ingress NGINX `LoadBalancer` service to preserve original client source IP.

#### 2. Developer → EKS Cluster
```
Developer Workstation (Office/VPN with allowed CIDR)
    ↓ (kubectl, HTTPS on port 443)
EKS Public API Endpoint (CIDR-restricted)
    ↓
EKS Control Plane
    ↓
Worker Nodes (Private Subnet)
```

#### 3. EKS Pods → Internet
```
Application Pod (Private Subnet)
    ↓
NAT Gateway (Public Subnet)
    ↓
Internet Gateway
    ↓
External Service (e.g., Docker Hub, GitHub)
```

---

## 3. Network Design

### VPC CIDR Allocation

**VPC CIDR Block:** `10.0.0.0/16` (65,536 IP addresses)

#### Subnet Allocation Strategy

Using `/20` subnets provides **4,096 IP addresses** per subnet, allowing for:
- Large pod deployments (EKS uses 1 IP per pod with VPC-CNI)
- Future growth without re-IPing
- Sufficient space for managed services

```
Subnet Type     | AZ  | CIDR Block      | Usable IPs | Purpose
----------------|-----|-----------------|------------|---------------------------
Public Subnet   | AZ1 | 10.0.0.0/20     | 4,091      | NAT GW, ALB, Internet GW
Public Subnet   | AZ2 | 10.0.32.0/20    | 4,091      | NAT GW (opt), ALB, Internet GW
Public Subnet   | AZ3 | 10.0.64.0/20    | 4,091      | NAT GW (opt), ALB, Internet GW
Private Subnet  | AZ1 | 10.0.16.0/20    | 4,091      | EKS nodes, pods, DocumentDB
Private Subnet  | AZ2 | 10.0.48.0/20    | 4,091      | EKS nodes, pods, DocumentDB (prod only)
Private Subnet  | AZ3 | 10.0.80.0/20    | 4,091      | EKS nodes, pods, DocumentDB (prod only)
```

**CIDR Calculation Formula:**
```hcl
# Public subnets: offset 0, 32, 64
cidrsubnet(vpc_cidr, 4, n * 2)      # n = 0, 1, 2

# Private subnets: offset 16, 48, 80
cidrsubnet(vpc_cidr, 4, n * 2 + 1)  # n = 0, 1, 2
```

#### Subnet Tagging for EKS

**Public Subnets (for external load balancers):**
```hcl
tags = {
  "kubernetes.io/role/elb"                          = "1"
  "kubernetes.io/cluster/${cluster_name}"           = "shared"
}
```

**Private Subnets (for internal load balancers):**
```hcl
tags = {
  "kubernetes.io/role/internal-elb"                 = "1"
  "kubernetes.io/cluster/${cluster_name}"           = "shared"
}
```

### NAT Gateway Strategy

#### Development Environment (Cost-Optimized)
- **AZ Count:** 3 (multi-availability zone)
- **NAT Gateway Count:** 1 NAT Gateway
- **Location:** Public subnet in AZ1
- **Cost:** ~$32/month + data transfer
- **Trade-off:** Single point of failure for internet egress (acceptable for dev/testing)

#### Production Environment (High Availability)
- **AZ Count:** 3 (multi-availability zone)
- **NAT Gateway Count:** 3 NAT Gateways (one per AZ)
- **Location:** One in each public subnet
- **Cost:** ~$96/month + data transfer
- **Benefit:** No single point of failure, AZ-independent internet access

### Route Tables

**Public Route Table:**
```
Destination     | Target
----------------|------------------
10.0.0.0/16     | local
0.0.0.0/0       | internet-gateway
```

**Private Route Tables (per AZ):**
```
Destination     | Target
----------------|---------------------------
10.0.0.0/16     | local
0.0.0.0/0       | nat-gateway-in-same-az
```

---

## 4. Security Model

### EKS Cluster Endpoint Access

#### Configuration Options

**Option 1: Private + Public with CIDR Restrictions (Default)**
```hcl
cluster_endpoint_private_access        = true
cluster_endpoint_public_access         = true
cluster_endpoint_public_access_cidrs   = ["203.0.113.0/24"]  # Your office/VPN
```

- ✅ kubectl works directly from allowed IPs
- ✅ No VPN or bastion required for developers
- ✅ Pods use private endpoint (never hit public internet)
- ✅ Can restrict to specific IP ranges
- ⚠️ Public endpoint exists (mitigated by CIDR restrictions)

**Option 2: Private Only (Maximum Security)**
```hcl
cluster_endpoint_private_access        = true
cluster_endpoint_public_access         = false
cluster_endpoint_public_access_cidrs   = []
```

- ✅ EKS API completely isolated from internet
- ✅ Maximum security posture
- ⚠️ Requires VPN, Transit Gateway, or bastion host for kubectl access

**Recommendation:** Use Option 1 with tightly restricted CIDR blocks for operational ease while maintaining security.

### Security Groups

#### EKS Cluster Security Group
```
Ingress Rules:
- Allow 443 from worker node security group (kubelet → API server)
- Allow all traffic from cluster security group (self-referencing)

Egress Rules:
- Allow all traffic (managed by AWS)
```

#### EKS Node Security Group
```
Ingress Rules:
- Allow all traffic from cluster security group
- Allow all traffic from node security group (self-referencing, pod-to-pod)
- Allow all traffic from internet through network load balancer (auto-created by AWS Load Balancer Controller)

Egress Rules:
- Allow all traffic (for pulling images, accessing AWS APIs)
```

#### DocumentDB Security Group
```
Ingress Rules:
- Allow TCP 27017 from EKS node security group

Egress Rules:
- None required (database doesn't initiate connections)
```

### IAM Users, Roles, and Policies

#### 1. EKS Cluster IAM Role
**Purpose:** Allows EKS control plane to manage AWS resources

**Managed Policies:**
- `AmazonEKSClusterPolicy`

**Trust Relationship:**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "eks.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

#### 2. EKS Node IAM Role
**Purpose:** Allows worker nodes to join cluster and pull images

**Managed Policies:**
- `AmazonEKSWorkerNodePolicy`
- `AmazonEKS_CNI_Policy`
- `AmazonEC2ContainerRegistryReadOnly`

**Trust Relationship:**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "ec2.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

#### 3. IRSA (IAM Roles for Service Accounts)

**OIDC Provider:**
- Automatically created for EKS cluster
- Allows Kubernetes service accounts to assume IAM roles

**Cluster Autoscaler Role Trust Policy:**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::{account-id}:oidc-provider/{oidc-url}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "{oidc-url}:sub": "system:serviceaccount:kube-system:cluster-autoscaler",
          "{oidc-url}:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
```

#### 4. S3 Credential Status IAM User
**Purpose:** Allows the Walt.id application to publish and manage credential status entries in S3

**Managed Policies:**
- `s3:PutObject` — publish new credential status entries
- `s3:DeleteObject` — revoke / remove status entries
- `s3:GetObject` — read back published entries
- `s3:ListBucket` — enumerate objects in the bucket

### Encryption

#### EKS Secrets Encryption
```hcl
encryption_config {
  resources = ["secrets"]
  
  provider {
    key_arn = "alias/aws/eks"  # AWS managed key
  }
}
```

- All Kubernetes secrets encrypted at rest
- Uses AWS managed KMS key (no key management overhead)
- Automatic key rotation handled by AWS

#### DocumentDB Encryption
- **At Rest:** Enabled by default using AWS managed encryption
- **In Transit:** Not required for internal communication within VPC, but can be enabled with TLS if needed
- No custom KMS key required

#### S3 Bucket Encryption
- **At Rest:** Automatic SSE-S3 (AES-256) encryption enabled by default
- **In Transit:** HTTPS/TLS enforced via bucket policy
- No custom KMS key required

### CORS

CORS is configured on the S3 credential status bucket to allow browsers to fetch status data directly. The bucket permits `GET` and `HEAD` requests from any origin (`*`) with a 1-hour preflight cache (`max-age: 3600`).

---

## 5. Cost Considerations

### S3 Bucket

#### Development Environment (Cost-Optimized)
- **Versioning:** Disabled
- **Trade-off:** No object history or recovery from accidental overwrites (acceptable for dev/testing)

#### Production Environment (Durability)
- **Versioning:** Enabled
- **Benefit:** Full object history, protection against accidental deletes, point-in-time recovery

---

## 6. Access Patterns

### Kubectl Access

#### Initial Configuration
```bash
# Configure kubectl to use the EKS cluster
aws eks update-kubeconfig \
  --region eu-north-1 \
  --name waltid-dev \
  --alias waltid-dev

# Verify access
kubectl get nodes
kubectl get pods --all-namespaces
```

#### Required Prerequisites
1. **AWS CLI** installed and configured with credentials
2. **kubectl** version 1.31 or compatible
3. **Your IP must be in** `cluster_endpoint_public_access_cidrs`

#### Access Denied Troubleshooting
If you get "You must be logged in to the server (Unauthorized)":

```bash
# 1. Verify AWS credentials
aws sts get-caller-identity

# 2. Regenerate kubeconfig
aws eks update-kubeconfig --region eu-north-1 --name waltid-dev

# 3. Check IAM role/user has permissions
# The role/user must have eks:DescribeCluster permission
```

If you get "connection refused" or timeout:
```bash
# Your IP is not in the CIDR allow-list
# Either:
# 1. Add your IP to cluster_endpoint_public_access_cidrs in tfvars
# 2. Set up VPN connection
# 3. Use AWS Systems Manager Session Manager
```
