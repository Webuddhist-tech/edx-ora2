"""
Tests for course items listing handlers.
"""

import json

from unittest import TestCase
from unittest.mock import MagicMock, patch

from opaque_keys.edx.keys import UsageKey

from openassessment.xblock.course_items_listing_mixin import enrich_ora_items_with_section

from .base import SubmitAssessmentsMixin, XBlockHandlerTestCase, scenario


class TestEnrichOraItemsWithSection(TestCase):
    """
    Tests for section enrichment on instructor dashboard ora items.
    """

    @patch('openassessment.xblock.course_items_listing_mixin.modulestore')
    def test_enrich_adds_chapter_from_vertical_parent_chain(self, mock_modulestore):
        course_key = 'course-v1:edX+DemoX+Demo_Course'
        vertical_key = UsageKey.from_string(
            'block-v1:edX+DemoX+Demo_Course+type@vertical+block@vertical1'
        )
        sequential_key = UsageKey.from_string(
            'block-v1:edX+DemoX+Demo_Course+type@sequential+block@seq1'
        )
        chapter_key = UsageKey.from_string(
            'block-v1:edX+DemoX+Demo_Course+type@chapter+block@chapter1'
        )

        vertical = MagicMock(
            location=vertical_key,
            parent=sequential_key,
            category='vertical',
        )
        sequential = MagicMock(
            location=sequential_key,
            parent=chapter_key,
            category='sequential',
            display_name='Lesson 1',
        )
        sequential.get_children = MagicMock(return_value=[vertical])
        chapter = MagicMock(location=chapter_key, category='chapter', display_name='Week 1')
        chapter.get_children = MagicMock(return_value=[sequential])

        store = MagicMock()
        store.get_course.return_value = MagicMock(
            get_children=lambda: [chapter],
        )
        store.get_item.side_effect = lambda key: {
            vertical_key: vertical,
            sequential_key: sequential,
            chapter_key: chapter,
        }[key]
        mock_modulestore.return_value = store

        ora_items = [{
            'id': 'ora1',
            'parent_id': str(vertical_key),
            'name': 'ORA 1',
        }]
        enrich_ora_items_with_section(course_key, ora_items)
        store.get_item.assert_not_called()

        self.assertEqual(ora_items[0]['section_id'], str(chapter_key))
        self.assertEqual(ora_items[0]['section_name'], 'Week 1')
        self.assertEqual(ora_items[0]['section_index'], 0)
        self.assertEqual(ora_items[0]['subsection_id'], str(sequential_key))
        self.assertEqual(ora_items[0]['subsection_name'], 'Lesson 1')
        self.assertEqual(ora_items[0]['subsection_index'], 0)

    @patch('openassessment.xblock.course_items_listing_mixin.modulestore')
    def test_enrich_climbs_when_unit_missing_from_outline_map(self, mock_modulestore):
        course_key = 'course-v1:edX+DemoX+Demo_Course'
        vertical_key = UsageKey.from_string(
            'block-v1:edX+DemoX+Demo_Course+type@vertical+block@orphan_vertical'
        )
        sequential_key = UsageKey.from_string(
            'block-v1:edX+DemoX+Demo_Course+type@sequential+block@seq1'
        )
        chapter_key = UsageKey.from_string(
            'block-v1:edX+DemoX+Demo_Course+type@chapter+block@chapter1'
        )

        vertical = MagicMock(parent=sequential_key, category='vertical')
        sequential = MagicMock(
            location=sequential_key,
            parent=chapter_key,
            category='sequential',
            display_name='Lesson 1',
        )
        sequential.get_children = MagicMock(return_value=[])
        chapter = MagicMock(location=chapter_key, category='chapter', display_name='Week 1')
        chapter.get_children = MagicMock(return_value=[sequential])

        store = MagicMock()
        store.get_course.return_value = MagicMock(get_children=lambda: [chapter])
        store.get_item.side_effect = lambda key: {
            vertical_key: vertical,
            sequential_key: sequential,
            chapter_key: chapter,
        }[key]
        mock_modulestore.return_value = store

        ora_items = [{'id': 'ora1', 'parent_id': str(vertical_key), 'name': 'ORA 1'}]
        enrich_ora_items_with_section(course_key, ora_items)

        self.assertEqual(ora_items[0]['section_name'], 'Week 1')
        self.assertTrue(store.get_item.called)


class TestCourseItemsListingHandlers(XBlockHandlerTestCase, SubmitAssessmentsMixin):
    """
    Test for course items listing handlers.
    """

    @scenario('data/basic_scenario.xml', user_id='Bob')
    def test_non_staff_access(self, xblock):
        """
        Test non-staff access for endpoint that return items statistics

        """
        response = self.request(xblock, 'get_ora2_responses', json.dumps({}),
                                request_method='GET')
        self.assertIn('You do not have permission', response.decode('utf-8'))

    @scenario('data/basic_scenario.xml', user_id='Bob')
    def test_staff_access(self, xblock):
        """
        Test staff access for endpoint that return items statistics

        """
        self.set_staff_access(xblock)
        xblock.xmodule_runtime.course_id = 'test_course'

        return_data = [{'id': 'test_1', 'title': 'title_1'},
                       {'id': 'test_2', 'title': 'title_2'}]
        with patch("openassessment.data.OraAggregateData.collect_ora2_responses", return_value=return_data):
            response = self.request(xblock, 'get_ora2_responses', json.dumps({}),
                                    request_method='GET', response_format='json')
            self.assertEqual(response, return_data)
