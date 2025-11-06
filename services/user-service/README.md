# 👤 User Service

This microservice handles all user-related operations for the distributed media platform.

Its core responsibilities are:
* Registering new users (with secure password hashing)
* Logging users in (generating a JWT)
* Verifying tokens for authenticated requests

## ⚙️ Setup & Installation

This service is designed to be run via Docker and Docker Compose. Dependencies are managed by `npm`.

### Local Development

If you are developing locally (outside of Docker) or your code editor needs to resolve the dependencies, you can install them manually.

**Prerequisites:**
* [Node.js](https://nodejs.org/) (v18 or later)

From the `services/user-service/` directory, run:

```bash
# Install all dependencies listed in package.json
npm install
