---
npm/hooka: patch (Fixed)
---

The release workflow now creates the `vX.Y.Z` tag and GitHub release only after the release images and immutable aliases are published, so a failed image build can be retried instead of leaving a tagged release without images.
