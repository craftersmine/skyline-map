# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue or pull request.

Use GitHub's private reporting: go to the repository's **Security** tab and click **Report a vulnerability**. Include what you found, how to reproduce it, and what an attacker could do with it.

You should get a first reply within a week. Once a fix is ready and deployed, the report can be published with credit to you, if you want it.

## Scope

Skyline Map is a static site: map and save files are parsed in the visitor's browser and never uploaded. Problems worth reporting include:

- a crafted `.cslmap` or `.crp` file that runs script in the page, leaks data or crashes the browser;
- cross-site scripting through city, road, station or building names;
- anything that sends a visitor's files or data somewhere without their knowledge.

Only the latest version, deployed at https://skyline.codz.me, is supported.
