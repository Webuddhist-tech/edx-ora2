"""
The mixin with handlers for the course ora blocks listing view.

"""

import json

from django.utils.translation import gettext as _
from opaque_keys.edx.keys import CourseKey, UsageKey
from webob import Response
from xblock.core import XBlock

from openassessment.runtime_imports.functions import modulestore
from openassessment.xblock.staff_area_mixin import require_course_staff


def _build_outline_maps(course_key):
    """
    Walk the course outline and map chapters, subsections, and units (verticals).
    """
    store = modulestore()
    chapter_order = {}
    subsection_order = {}
    unit_outline = {}
    try:
        course = store.get_course(course_key)
        if course:
            for ch_idx, chapter in enumerate(course.get_children()):
                if chapter.category != 'chapter':
                    continue
                chapter_id = str(chapter.location)
                chapter_order[chapter_id] = (ch_idx, chapter.display_name)
                for seq_idx, child in enumerate(chapter.get_children()):
                    if child.category == 'sequential':
                        seq_id = str(child.location)
                        subsection_order[seq_id] = (
                            ch_idx,
                            seq_idx,
                            child.display_name,
                        )
                        for vertical in child.get_children():
                            if vertical.category == 'vertical':
                                unit_outline[str(vertical.location)] = {
                                    'section_id': chapter_id,
                                    'section_name': str(chapter.display_name),
                                    'section_index': ch_idx,
                                    'subsection_id': seq_id,
                                    'subsection_name': str(child.display_name),
                                    'subsection_index': seq_idx,
                                }
                    elif child.category == 'vertical':
                        unit_outline[str(child.location)] = {
                            'section_id': chapter_id,
                            'section_name': str(chapter.display_name),
                            'section_index': ch_idx,
                            'subsection_id': '',
                            'subsection_name': str(_('Other')),
                            'subsection_index': 9999,
                        }
    except Exception:  # pylint: disable=broad-except
        pass
    return chapter_order, subsection_order, unit_outline


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
    except Exception:  # pylint: disable=broad-except
        return _empty_outline_fields()


def enrich_ora_items_with_section(course_id, ora_items):
    """
    Add section and subsection outline fields to each instructor-dashboard ora item.
    """
    if not ora_items:
        return ora_items

    store = modulestore()
    course_key = CourseKey.from_string(course_id)
    chapter_order, subsection_order, unit_outline = _build_outline_maps(course_key)
    cache = {}

    for item in ora_items:
        parent_id = item.get('parent_id')
        if not parent_id:
            item.update(_empty_outline_fields())
            continue
        if parent_id not in cache:
            if parent_id in unit_outline:
                cache[parent_id] = unit_outline[parent_id]
            else:
                try:
                    usage_key = UsageKey.from_string(parent_id)
                except Exception:  # pylint: disable=broad-except
                    cache[parent_id] = _empty_outline_fields()
                else:
                    cache[parent_id] = _outline_for_unit(
                        store,
                        usage_key,
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
