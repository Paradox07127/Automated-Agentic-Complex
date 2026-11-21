"""Pi catalog providers a runtime provider may name; each keeps its key in its own backend.

Selecting a profile never switches providers, copies native CLI credentials or
guesses model ids. The user must save the matching backend's API key.
"""
DEEPSEEK_BASE_URL = "https://api.deepseek.com"
XAI_BASE_URL = "https://api.x.ai/v1"

PROFILES = {
    'xai': {'title': 'Grok / xAI', 'base_url': XAI_BASE_URL,
            'docs': 'https://docs.x.ai/developers/tools/function-calling'},
    'deepseek': {'title': 'DeepSeek', 'base_url': DEEPSEEK_BASE_URL, 'docs': 'https://api-docs.deepseek.com/'},
}


def catalog():
    return [{'id': name, **profile, 'harness': 'pi', 'credential_backend': name, 'auth_source': 'api_key',
             'model_required': True, 'live_provider_verified': False}
            for name, profile in PROFILES.items()]


def connection(provider, settings, auth_source):
    if auth_source != 'api_key':
        raise ValueError('provider_profile_requires_api_key')
    return {'provider': provider, 'auth_source': auth_source,
            'base_url': settings['backends'][provider]['base_url'].rstrip('/')}
