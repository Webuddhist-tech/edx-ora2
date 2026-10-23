"""
The mixin with handlers for the course ora blocks listing view.

"""

import json

from django.utils.translation import gettext as _
from opaque_keys.edx.keys import CourseKey, UsageKey
from webob import Response
from xblock.core import XBlock
from xmodule.modulestore.exceptions import ItemNotFoundError

from openassessment.runtime_imports.functions import modulestore
from openassessment.xblock.staff_area_mixin import require_course_staff


def _outline_order_maps(course_key):
    """
    Map chapter and sequential usage keys to outline order and display names.
    """
    store = modulestore()
    chapter_order = {}
    subsection_order = {}
    try:
        course = store.get_course(course_key)
        if course:
            for ch_idx, chapter in enumerate(course.get_children()):
                if chapter.category != 'chapter':
                    continue
                chapter_order[str(chapter.location)] = (ch_idx, chapter.display_name)
                for seq_idx, sequential in enumerate(chapter.get_children()):
                    if sequential.category == 'sequential':
                        subsection_order[str(sequential.location)] = (
                            ch_idx,
                            seq_idx,
                            sequential.display_name,
                        )
    except ItemNotFoundError:
        pass
    return chapter_order, subsection_order


def _empty_outline_fields():
    return {
        'section_id': '',
        'section_name': str(_('Other')),
        'section_index': 9999,
        'subsection_id': '',
        'subsection_name': str(_('Other')),
        'subsection_index': 9999,
    }


def _outline_for_unit(store, vertical_usage_key, chapter_order, subsection_order):
    """
    Resolve chapter (section) and sequential (subsection) for a unit (vertical).
    """
    try:
        vertical = store.get_item(vertical_usage_key)
        parent = store.get_item(vertical.parent)
        sequential = None
        if parent.category == 'sequential':
            sequential = parent
            chapter = store.get_item(parent.parent)
        elif parent.category == 'chapter':
            chapter = parent
        else:
            return _empty_outline_fields()
        if chapter.category != 'chapter':
            return _empty_outline_fields()

        section_id = str(chapter.location)
        section_index, section_name = chapter_order.get(
            section_id, (9999, chapter.display_name)
        )

        if sequential:
            subsection_id = str(sequential.location)
            _, subsection_index, subsection_name = subsection_order.get(
                subsection_id,
                (section_index, 9999, sequential.display_name),
            )
        else:
            subsection_id = ''
            subsection_name = str(_('Other'))
            subsection_index = 9999

        return {
            'section_id': section_id,
            'section_name': str(section_name),
            'section_index': section_index,
            'subsection_id': subsection_id,
            'subsection_name': str(subsection_name),
            'subsection_index': subsection_index,
        }
    except (ItemNotFoundError, AttributeError):
        return _empty_outline_fields()


def enrich_ora_items_with_section(course_id, ora_items):
    """
    Add section and subsection outline fields to each instructor-dashboard ora item.
    """
    if not ora_items:
        return ora_items

    store = modulestore()
    course_key = CourseKey.from_string(course_id)
    chapter_order, subsection_order = _outline_order_maps(course_key)
    cache = {}

    for item in ora_items:
        parent_id = item.get('parent_id')
        if not parent_id:
            item.update(_empty_outline_fields())
            continue
        if parent_id not in cache:
            cache[parent_id] = _outline_for_unit(
                store,
                UsageKey.from_string(parent_id),
                chapter_order,
                subsection_order,
            )
        item.update(cache[parent_id])

    return ora_items


class CourseItemsListingMixin:
    """
    The mixin with handlers for the course ora blocks listing view.

    """

    @XBlock.handler
    @require_course_staff('STAFF_AREA')
    def get_ora2_responses(self, request, suffix=''):  # pylint: disable=unused-argument
        """
        Get information about all ora2 blocks in the course with response count for each step.

        """
        # Import is placed here to avoid model import at project startup.
        from openassessment.data import OraAggregateData
        responses = OraAggregateData.collect_ora2_responses(str(self.course_id))
        return Response(json.dumps(responses), content_type='application/json', charset='UTF-8')
