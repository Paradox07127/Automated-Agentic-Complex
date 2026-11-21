"""Agentd facing rules; idle keeps the current pose and foreground tools take priority."""
import math
import threading
import time

from observation.spatial import ATTEND


FACING_TOOL = {'name':'avatar_face','description':
    'Turn your desktop body when there is a reason: face the user while you talk with them, turn partly aside to give them room while they focus, '
    'or turn slightly to keep them company looking the same way; if uncertain, keep the pose by not calling, and follow no fixed focus-time sequence. '
    'yaw_degrees is relative to the original front: 0 faces the user, signed angles turn sideways, and the body turns at most 30 degrees to either side (larger angles are clamped to 30). '
    'Accepted only requests the turn animation, and manual orientation or a missing animation may refuse it; check avatar_facing_status before saying you turned.',
    'input_schema':{'type':'object','properties':{
        'yaw_degrees':{'type':'number','minimum':-180,'maximum':180,'description':'Target angle relative to the original front; 0 faces the user.'},
        'reason':{'type':'string','minLength':1,'maxLength':200,'description':'Short note on why, for the log; not spoken.'},
        'hold_seconds':{'type':'number','minimum':1,'maximum':300,'description':'How long automatic facing leaves this pose alone; default 60.'}},
        'required':['yaw_degrees','reason'],'additionalProperties':False}}

FACING_STATUS_TOOL = {'name':'avatar_facing_status','description':
    'Read the execution receipt for your latest body-facing request, or for one behavior_id, after avatar_face and before you mention having turned. '
    'Only phase completed confirms that request; requested, prepared and running do not. '
    'requested_yaw is the requested target, not a live measurement; the body turns at most 30 degrees to either side, so beyond that the actual angle is 30 degrees.',
    'input_schema':{'type':'object','properties':{'behavior_id':{'type':'string','maxLength':64,'description':'Optional behavior_id from avatar_face; omit for the latest request.'}},'additionalProperties':False}}


def validate(value):
    if not isinstance(value,dict) or set(value)!={'yaw_degrees','hold_seconds','reason'}:
        raise ValueError('invalid_facing_decision')
    yaw,hold,reason=value['yaw_degrees'],value['hold_seconds'],value['reason']
    def number(v,lo,hi):return not isinstance(v,bool) and isinstance(v,(int,float)) and math.isfinite(v) and lo<=v<=hi
    if yaw is not None and not number(yaw,-180,180) or not number(hold,1,300) \
            or not isinstance(reason,str) or not 1<=len(reason)<=200:
        raise ValueError('invalid_facing_decision')


class FacingDecisions:
    def __init__(self,semantic,execute,min_interval_s=180,clock=time.monotonic):
        self.execute,self.clock=execute,clock
        self.interval=max(5,min(30,min_interval_s))
        self.lock=threading.RLock()
        self.epoch=0;self.running=False;self.last=-math.inf;self.deferred=-math.inf
        self.last_result=None;self.error=None

    def defer(self,seconds):
        """A foreground agent tool owns the next decision."""
        with self.lock:
            self.epoch+=1;self.deferred=self.clock()+seconds

    def apply(self,context,*,allowed,valid=lambda:True):
        with self.lock:
            if not allowed or not valid() or context.get('activity') in ('away','meeting') \
                    or context.get('presence') == 'afk' or context.get('locked') \
                    or context.get('meeting') or context.get('giving_way'):
                self.epoch+=1
                return
            attend=context.get('state') in ('listen','attend','attend_session') \
                or context.get('session') is not None and context.get('state') in ATTEND \
                or context.get('attending',False)
            if not any(context.get(k) for k in ('user_speaking','speaking','voicing')) and not attend:
                self.last=-math.inf
                return
            if self.clock()<self.deferred or self.running or self.clock()-self.last<self.interval:return
            epoch=self.epoch;self.last=self.clock();self.running=True;self.error=None
            def current():
                with self.lock:return self.epoch==epoch and valid()
            try:
                value=dict(yaw_degrees=0,hold_seconds=60,reason='speech_or_attend')
                receipt=self.execute(0,value['reason'],value['hold_seconds'],current)
                if current():self.last_result={'decision':value,'receipt':receipt}
            finally:
                self.running=False
