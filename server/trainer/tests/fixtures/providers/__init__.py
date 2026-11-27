"""One fixture per source provider; the contract suite runs against every entry."""

from .braintrust import BraintrustFixture
from .gradiated import GradiatedFixture
from .langfuse import LangfuseFixture
from .langsmith import LangSmithFixture
from .phoenix import PhoenixFixture
from .posthog import PostHogFixture

FIXTURES = [LangfuseFixture, LangSmithFixture, BraintrustFixture, PostHogFixture, PhoenixFixture, GradiatedFixture]
