const LISTING_STORAGE_VERSION = 'v1';

function listingStorageKey(courseId) {
  return `ora-instructor-listing:${LISTING_STORAGE_VERSION}:${courseId}`;
}

function readListingCheckpoint(courseId) {
  if (!courseId || !window.sessionStorage) {
    return null;
  }
  try {
    const raw = window.sessionStorage.getItem(listingStorageKey(courseId));
    if (!raw) {
      return null;
    }
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function writeListingCheckpoint(courseId, checkpoint) {
  if (!courseId || !window.sessionStorage) {
    return;
  }
  try {
    window.sessionStorage.setItem(listingStorageKey(courseId), JSON.stringify(checkpoint));
  } catch (e) {
    // sessionStorage unavailable
  }
}

function clearListingScrollTarget(courseId) {
  const checkpoint = readListingCheckpoint(courseId);
  if (!checkpoint || !checkpoint.scrollOraId) {
    return;
  }
  const { scrollOraId, ...rest } = checkpoint;
  writeListingCheckpoint(courseId, rest);
}

function applyCheckpointToOutline(view, sections, checkpoint) {
  if (!checkpoint) {
    return;
  }
  const wantSection = checkpoint.section_id || '';
  const wantSubsection = checkpoint.subsection_id || '';
  sections.forEach((sectionGroup, sectionIndex) => {
    const sectionKey = sectionGroup.section_id || `ungrouped-${sectionIndex}`;
    const sectionMatch = wantSection === (sectionGroup.section_id || '');
    if (!sectionMatch) {
      return;
    }
    view.setOutlineOpen(sectionKey, true);
    sectionGroup.subsections.forEach((subsectionGroup, subIndex) => {
      const subKey = subsectionGroup.subsection_id || `ungrouped-sub-${subIndex}`;
      const subMatch = wantSubsection === (subsectionGroup.subsection_id || '');
      if (subMatch) {
        view.setOutlineOpen(subKey, true);
      }
    });
  });
}

function groupOraItemsBySectionAndSubsection(items) {
  const sections = {};
  items.forEach((item) => {
    const sectionKey = item.section_id || '__ungrouped__';
    if (!sections[sectionKey]) {
      sections[sectionKey] = {
        section_id: item.section_id || '',
        section_name: item.section_name || gettext('Other'),
        section_index: item.section_index != null ? item.section_index : 9999,
        subsections: {},
      };
    }
    const subKey = item.subsection_id || '__ungrouped_sub__';
    if (!sections[sectionKey].subsections[subKey]) {
      sections[sectionKey].subsections[subKey] = {
        subsection_id: item.subsection_id || '',
        subsection_name: item.subsection_name || gettext('Other'),
        subsection_index: item.subsection_index != null ? item.subsection_index : 9999,
        items: [],
      };
    }
    sections[sectionKey].subsections[subKey].items.push(item);
  });
  return Object.values(sections)
    .sort((a, b) => a.section_index - b.section_index)
    .map((section) => ({
      ...section,
      subsections: Object.values(section.subsections).sort(
        (a, b) => a.subsection_index - b.subsection_index,
      ),
    }));
}

function setCollapsibleExpanded($group, expanded, animate, toggleClass, bodyClass) {
  const $header = $group.find(toggleClass);
  const $body = $group.find(bodyClass);
  $header.attr('aria-expanded', expanded ? 'true' : 'false');
  if (animate) {
    if (expanded) {
      $body.slideDown(150);
    } else {
      $body.slideUp(150);
    }
  } else if (expanded) {
    $body.show();
  } else {
    $body.hide();
  }
}

function appendCollapsibleToggle($group, label, count, toggleClass, chevronClass, expanded) {
  const $header = $('<button>', {
    type: 'button',
    class: toggleClass,
    'aria-expanded': expanded ? 'true' : 'false',
  });
  $header.append(
    $('<span>', { class: chevronClass, 'aria-hidden': 'true' }),
    document.createTextNode(` ${label} (${count})`),
  );
  $group.append($header);
  return $header;
}

export class CourseItemsListingView {
  constructor(runtime, element, data) {
    const self = this;
    const $section = $(element);
    const block = $section.find('.open-response-assessment-block');
    const itemViewEnabled = (parseInt(block.data('item-view-enabled'), 10) === 1) && XBlock;
    const dataRendered = parseInt(block.data('rendered'), 10);

    this.$section = $section;
    this.runtime = runtime;
    this.oraData = $.parseJSON($('#open-response-assessment-items').text());
    this.data = data;

    if (!dataRendered) { // if rendered, we're returning after tabbing away
      $section.find('.open-response-assessment-content').hide();
      $section.find('.open-response-assessment-item').hide();
      $section.find('.open-response-assessment-msg').show();
    }

    const context = this.data.CONTEXT || {};
    this.courseId = context.COURSE_ID || '';
    this._pendingScrollOraId = null;
    const sessionCheckpoint = readListingCheckpoint(this.courseId);
    this._applySessionOutlineOnNextGrid = Boolean(
      sessionCheckpoint && (sessionCheckpoint.section_id !== undefined),
    );
    if (sessionCheckpoint && sessionCheckpoint.scrollOraId) {
      this._pendingScrollOraId = sessionCheckpoint.scrollOraId;
    }

    const AssessmentCell = Backgrid.UriCell.extend({
      type: null,
      url: null,
      // Should be removed as a part of AU-617
      shouldShowLink() {
        return true;
      },
      render() {
        this.$el.empty();
        const name = this.column.get('name');
        this.$el.addClass(name);
        const url = this.model.get(this.url ? this.url : 'url_base');
        const rawValue = this.model.get(name);
        const formattedValue = this.formatter.fromRaw(rawValue, this.model);
        const hasAssessmentType = this.model.get(this.type ? this.type : 'staff_assessment');
        let link = null;
        if (itemViewEnabled && (!this.type || (this.type && hasAssessmentType)) && this.shouldShowLink()) {
          link = $('<a>', {
            text: formattedValue,
            title: this.title || formattedValue,
          });
          this.$el.append(link);
          link.on('click', $.proxy(self, 'displayOraBlock', url));
        } else {
          this.$el.append(formattedValue);
        }
        this.delegateEvents();
        return this;
      },
    });

    const esgEnabled = context.ENHANCED_STAFF_GRADER;
    const esgRootUrl = context.ORA_GRADING_MICROFRONTEND_URL;

    const ESGCell = Backgrid.UriCell.extend({
      render() {
        this.$el.empty();
        const name = this.column.get('name');
        this.$el.addClass(name);
        const displayValue = esgEnabled ? gettext('View and grade responses') : gettext('Demo the new Grading Experience');
        const id = this.model.get('id');
        const url = `${esgRootUrl}/${id}`;
        const hasAssessmentType = this.model.get('staff_assessment');
        const link = $('<a>', {
          text: displayValue,
          title: displayValue,
          href: url,
          class: 'staff-esg-link',
        });
        // Remove this in AU-617
        const teamAssignment = this.model.get('team_assignment');
        if (hasAssessmentType && !teamAssignment) {
          link.on('click', () => {
            self.saveListingCheckpoint(this.model);
          });
          this.$el.append(link);
        }
        return this;
      },
    });

    const WaitingStepCell = AssessmentCell.extend({
      type: 'peer_assessment',
      url: 'url_waiting_step_details',
    });

    const StaffCell = AssessmentCell.extend({
      url: 'url_grade_available_responses',
      type: 'staff_assessment',
      // Should be removed as a part of AU-617
      shouldShowLink() {
        return this.model.get('team_assignment') || !esgEnabled;
      },
    });

    this._columns = [
      {
        name: 'parent_name',
        label: gettext('Unit Name'),
        label_summary: gettext('Units'),
        cell: 'string',
        num: false,
        editable: false,
      },
      {
        name: 'name',
        label: gettext('Assessment'),
        label_summary: gettext('Assessments'),
        cell: AssessmentCell,
        num: false,
        editable: false,
      },
      {
        name: 'total',
        label: gettext('Total Responses'),
        label_summary: gettext('Total Responses'),
        cell: 'string',
        num: true,
        editable: false,
      },
      {
        name: 'training',
        label: gettext('Training'),
        label_summary: gettext('Training'),
        cell: 'string',
        num: true,
        editable: false,
      },
      {
        name: 'peer',
        label: gettext('Peer'),
        label_summary: gettext('Peer'),
        cell: 'string',
        num: true,
        editable: false,
      },
      {
        name: 'self',
        label: gettext('Self'),
        label_summary: gettext('Self'),
        cell: 'string',
        num: true,
        editable: false,
      },
      {
        name: 'waiting',
        label: gettext('Waiting'),
        label_summary: gettext('Waiting'),
        cell: WaitingStepCell,
        num: true,
        editable: false,
      },
      {
        name: 'staff',
        label: gettext('Staff'),
        label_summary: gettext('Staff'),
        cell: StaffCell,
        num: true,
        editable: false,
      },
      {
        name: 'done',
        label: gettext('Final Grade Received'),
        label_summary: gettext('Final Grade Received'),
        cell: 'string',
        num: true,
        editable: false,
      },
      {
        name: 'staff_grader',
        label: gettext('Staff Grader'),
        cell: ESGCell,
        num: true,
        editable: false,
      },
    ];
  }

  /* eslint-disable-next-line consistent-return */
  refreshGrids(force) {
    force = force || false;

    const self = this;
    const { $section } = this;
    const block = $section.find('.open-response-assessment-block');
    const dataUrl = this.runtime.handlerUrl($section, 'get_ora2_responses');
    const dataRendered = parseInt(block.data('rendered'), 10);

    if (!dataRendered || force) {
      // eslint-disable-next-line new-cap
      return $.Deferred(
        (defer) => {
          $.ajax({
            type: 'GET',
            dataType: 'json',
            url: dataUrl,
          }).done((data) => {
            self.renderGrids(data);
            defer.resolve();
          }).fail((data, textStatus) => {
            $section.find('.open-response-assessment-msg')
              .text(gettext('List of Open Assessments is unavailable'));
            defer.rejectWith(self, [textStatus]);
          });
        },
      ).promise();
    }
  }

  renderGrids(data) {
    const self = this;
    const { $section } = this;
    const block = $section.find('.open-response-assessment-block');
    const oraSteps = ['training', 'peer', 'self', 'waiting', 'staff', 'done'];

    $.each(self.oraData, (i, oraItem) => {
      let total = 0;
      const itemId = oraItem.id;

      $.each(oraSteps, (j, step) => {
        oraItem[step] = 0;
      });

      if (itemId in data) {
        _.extend(oraItem, data[itemId]);
        if (oraItem.staff_assessment) {
          oraItem.staff = oraItem.waiting;
          oraItem.waiting = 0;
        }
      }

      $.each(oraSteps, (j, step) => {
        total += oraItem[step];
      });

      oraItem.total = total;
    });

    block.data('rendered', 1);
    $section.find('.open-response-assessment-msg').hide();
    self.showSummaryGrid(self.oraData);
    self.showOpenResponsesGrid(self.oraData);
  }

  showSummaryGrid(data) {
    const { $section } = this;
    const summaryData = [];
    const summaryDataMap = {};

    $section.find('.open-response-assessment-summary').empty();

    $.each(this._columns, (index, v) => {
      // if label_summary is undefined, do not show it
      if (v.label_summary === undefined) { return; }
      summaryData.push({
        title: v.label_summary,
        value: 0,
        num: v.num,
        class: v.name,
      });
      summaryDataMap[v.name] = index;
    });

    $.each(data, (index, obj) => {
      $.each(obj, (key, value) => {
        let idx = 0;
        if (key in summaryDataMap) {
          idx = summaryDataMap[key];
          if (summaryData[idx].num) {
            summaryData[idx].value += value;
          } else {
            summaryData[idx].value += 1;
          }
        }
      });
    });

    const templateData = _.template($('#open-response-assessment-summary-tpl').text());
    $section.find('.open-response-assessment-summary').append(templateData({
      oraSummary: summaryData,
    }));
  }

  isOutlineOpen(key) {
    return Boolean(this._openOutlineIds && this._openOutlineIds.has(key));
  }

  setOutlineOpen(key, expanded) {
    if (!this._openOutlineIds) {
      this._openOutlineIds = new Set();
    }
    if (expanded) {
      this._openOutlineIds.add(key);
    } else {
      this._openOutlineIds.delete(key);
    }
  }

  saveListingCheckpoint(model) {
    if (!this.courseId || !model) {
      return;
    }
    writeListingCheckpoint(this.courseId, {
      section_id: model.get('section_id') || '',
      subsection_id: model.get('subsection_id') || '',
      scrollOraId: model.get('id') || '',
    });
  }

  applySessionOutlineRestore(sections) {
    if (!this._applySessionOutlineOnNextGrid) {
      return;
    }
    this._applySessionOutlineOnNextGrid = false;
    this._openOutlineIds = new Set();
    const checkpoint = readListingCheckpoint(this.courseId);
    applyCheckpointToOutline(this, sections, checkpoint);
  }

  focusListingRow(oraId) {
    if (!oraId) {
      return;
    }
    const { $section } = this;
    const $row = $section.find('tr[data-ora-id]').filter(
      (_, el) => $(el).attr('data-ora-id') === oraId,
    );
    if (!$row.length) {
      return;
    }
    $row.addClass('ora-listing-row--focus');
    const el = $row.get(0);
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    clearListingScrollTarget(this.courseId);
    this._pendingScrollOraId = null;
  }

  showOpenResponsesGrid(data) {
    const { $section } = this;
    const $container = $section.find('.open-response-assessment-main-table');

    $section.find('.open-response-assessment-content').show();
    $container.empty();

    const sections = groupOraItemsBySectionAndSubsection(data);
    this.applySessionOutlineRestore(sections);
    const $sectionsRoot = $('<div>', { class: 'ora-listing-sections' });

    if (sections.length > 0) {
      const $controls = $('<div>', { class: 'ora-listing-section-controls' });
      const $expandAll = $('<input>', {
        type: 'button',
        class: 'enrollment-button',
        value: gettext('Expand all'),
      });
      const $collapseAll = $('<input>', {
        type: 'button',
        class: 'enrollment-button',
        value: gettext('Collapse all'),
      });
      $expandAll.on('click', () => {
        $sectionsRoot.find('.ora-listing-section').each((_, el) => {
          const $el = $(el);
          this.setOutlineOpen($el.attr('data-section-id'), true);
          setCollapsibleExpanded(
            $el, true, false, '.ora-listing-section__toggle', '.ora-listing-section__body',
          );
        });
        $sectionsRoot.find('.ora-listing-subsection').each((_, el) => {
          const $el = $(el);
          this.setOutlineOpen($el.attr('data-subsection-id'), true);
          setCollapsibleExpanded(
            $el, true, false, '.ora-listing-subsection__toggle', '.ora-listing-subsection__body',
          );
        });
      });
      $collapseAll.on('click', () => {
        $sectionsRoot.find('.ora-listing-subsection').each((_, el) => {
          const $el = $(el);
          this.setOutlineOpen($el.attr('data-subsection-id'), false);
          setCollapsibleExpanded(
            $el, false, false, '.ora-listing-subsection__toggle', '.ora-listing-subsection__body',
          );
        });
        $sectionsRoot.find('.ora-listing-section').each((_, el) => {
          const $el = $(el);
          this.setOutlineOpen($el.attr('data-section-id'), false);
          setCollapsibleExpanded(
            $el, false, false, '.ora-listing-section__toggle', '.ora-listing-section__body',
          );
        });
      });
      $controls.append($expandAll, $collapseAll);
      $container.append($controls);
    }

    sections.forEach((sectionGroup, sectionIndex) => {
      const sectionKey = sectionGroup.section_id || `ungrouped-${sectionIndex}`;
      const sectionOraCount = sectionGroup.subsections.reduce(
        (total, sub) => total + sub.items.length,
        0,
      );
      const $section = $('<div>', {
        class: 'ora-listing-section',
        'data-section-id': sectionKey,
      });
      const sectionOpen = this.isOutlineOpen(sectionKey);
      const $sectionHeader = appendCollapsibleToggle(
        $section,
        sectionGroup.section_name,
        sectionOraCount,
        'ora-listing-section__toggle',
        'ora-listing-section__chevron',
        sectionOpen,
      );
      const $sectionBody = $('<div>', { class: 'ora-listing-section__body' });
      if (!sectionOpen) {
        $sectionBody.hide();
      }

      sectionGroup.subsections.forEach((subsectionGroup, subIndex) => {
        const subKey = subsectionGroup.subsection_id || `ungrouped-sub-${subIndex}`;
        const $subsection = $('<div>', {
          class: 'ora-listing-subsection',
          'data-subsection-id': subKey,
        });
        const subCount = subsectionGroup.items.length;
        const subOpen = this.isOutlineOpen(subKey);
        const $subHeader = appendCollapsibleToggle(
          $subsection,
          subsectionGroup.subsection_name,
          subCount,
          'ora-listing-subsection__toggle',
          'ora-listing-subsection__chevron',
          subOpen,
        );

        const $subBody = $('<div>', { class: 'ora-listing-subsection__body' });
        if (!subOpen) {
          $subBody.hide();
        }
        const $tableHost = $('<div>', { class: 'ora-listing-section__grid' });

        const collection = new Backbone.Collection(subsectionGroup.items);
        const grid = new Backgrid.Grid({
          columns: this._columns,
          collection,
          row: Backgrid.Row.extend({
            render() {
              Backgrid.Row.prototype.render.apply(this, arguments);
              const oraId = this.model.get('id');
              if (oraId) {
                this.$el.attr('data-ora-id', oraId);
              }
              return this;
            },
          }),
        });
        $tableHost.append(grid.render().el);
        $subBody.append($tableHost);

        $subHeader.on('click', () => {
          const expanded = $subHeader.attr('aria-expanded') !== 'true';
          this.setOutlineOpen(subKey, expanded);
          setCollapsibleExpanded(
            $subsection,
            expanded,
            true,
            '.ora-listing-subsection__toggle',
            '.ora-listing-subsection__body',
          );
        });

        $subsection.append($subBody);
        $sectionBody.append($subsection);
      });

      $sectionHeader.on('click', () => {
        const expanded = $sectionHeader.attr('aria-expanded') !== 'true';
        this.setOutlineOpen(sectionKey, expanded);
        setCollapsibleExpanded(
          $section,
          expanded,
          true,
          '.ora-listing-section__toggle',
          '.ora-listing-section__body',
        );
      });

      $section.append($sectionBody);
      $sectionsRoot.append($section);
    });

    $container.append($sectionsRoot);

    if (this._pendingScrollOraId) {
      const oraId = this._pendingScrollOraId;
      window.setTimeout(() => {
        this.focusListingRow(oraId);
      }, 0);
    }
  }

  displayOraBlock(url) {
    const { $section } = this;
    const self = this;

    $section.find('.open-response-assessment-content').hide();
    $section.find('.open-response-assessment-msg').text(gettext('Please wait')).show();

    // eslint-disable-next-line new-cap
    return $.Deferred(
      (defer) => {
        $.ajax({
          type: 'GET',
          dataType: 'json',
          url,
        }).done((data) => {
          const el = $section.find('.open-response-assessment-item');
          const block = el.find('.open-response-assessment-item-block');

          $section.find('.open-response-assessment-msg').hide();
          el.show();
          self.renderBreadcrumbs();
          block.html(data.html);

          XBlock.initializeBlock($(block).find('.xblock')[0]);

          defer.resolve();
        }).fail((data, textStatus) => {
          $section.find('.open-response-assessment-item').show();
          $section.find('.open-response-assessment-msg')
            .text(gettext('Block view is unavailable'));

          self.renderBreadcrumbs();
          defer.rejectWith(self, [textStatus]);
        });
      },
    ).promise();
  }

  renderBreadcrumbs() {
    const { $section } = this;
    const breadcrumbs = $section.find('.open-response-assessment-item-breadcrumbs');
    const text = gettext('Back to Full List');
    const fullListItem = $('<a>', {
      html: `&larr;&nbsp;${text}`,
      title: text,
    });

    breadcrumbs.append(fullListItem);
    fullListItem.on('click', $.proxy(this, 'backToOpenResponsesGrid'));
  }

  backToOpenResponsesGrid() {
    const { $section } = this;
    $section.find('.open-response-assessment-item-breadcrumbs').empty();
    $section.find('.open-response-assessment-item-block').empty();
    $section.find('.open-response-assessment-item').hide();
    $section.find('.open-response-assessment-msg').text(gettext('Please wait')).show();
    this.refreshGrids(true);
  }
}
export default CourseItemsListingView;
