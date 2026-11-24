"""Protected path components shared by approval classification and extension roots."""

SECRET_PARTS = {".ssh", ".gnupg", "LaunchAgents", "LaunchDaemons", ".aws", ".kube", ".azure", ".docker",
                ".config/gcloud", "Keychains"}


def secret_path(path):
    """Whether a normalised path with forward slashes names or lies under a SECRET_PARTS entry, in any case."""
    path = f"/{path}/".casefold()
    return any(f"/{part.casefold()}/" in path for part in SECRET_PARTS)
