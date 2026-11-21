"""Activity reads retain the rule label, including unknown."""


class ActivityDecisions:
    def __init__(self, semantic, min_interval_s=180, clock=None):
        self.result = None
        self.running = False
        self.semantic = semantic

    def apply(self, inputs, scene):
        service=getattr(self.semantic.controller,'observations',None) if hasattr(self.semantic,'controller') else None
        if service is None: return scene
        current=service.understanding()
        return {**scene,'understanding':current,'semantic_available':bool(current.get('tasks')),
                'semantic_as_of':current.get('interpreted_at')}
