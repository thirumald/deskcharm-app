import pytest

from copilot.extractor import extract
from copilot.lang import detect_lang
from copilot.location import LocationEngine
from copilot.text import normalize, original_span


def cues(t):
    return {c.id for c in extract(t).cues}


def test_normalize_keeps_span_map():
    text = "مُحَمَّد في الحَرِيق"
    n, idx = normalize(text)
    i = n.index("الحريق")
    assert original_span(text, idx, i, i + len("الحريق")) == "الحَرِيق"


@pytest.mark.parametrize("text,cue", [
    ("my dad is not breathing", "not_breathing"), ("he stopped breathing!", "not_breathing"),
    ("ابني ما يتنفس", "not_breathing"), ("ابوي فاقد الوعي", "unconscious"),
    ("he has a knife", "weapon"), ("معه سكين", "weapon"), ("the fire is spreading fast", "fire_spreading"),
    ("two people trapped inside", "trapped"), ("there is a baby in the car", "child"), ("smell of gas everywhere", "hazard_gas"),
])
def test_critical_cues_detected(text, cue):
    assert cue in cues(text)


@pytest.mark.parametrize("text,cue", [
    ("he has no weapon", "weapon"), ("he is unarmed and without a knife", "weapon"), ("بدون سلاح", "weapon"),
    ("the fire is not spreading", "fire_spreading"),
])
def test_negated_cues_suppressed(text, cue):
    assert cue not in cues(text)


def test_entities_en_and_ar():
    e = extract("He is sixty eight years old, there are three people, building 14, plate number A 12345")
    assert e.ages == [68] and e.persons == 3 and "building 14" in e.address_detail and e.plates == ["A12345"]
    e = extract("عمره ٦ سنوات و خمسة اشخاص في الدور الخامس")
    assert 6 in e.ages and e.persons == 5 and "floor 5" in e.address_detail
    assert "child" in {c.id for c in e.cues}  # age <= 12 raises the child cue


def test_incident_types():
    assert extract("there is a fire and smoke").incident_type == "FIRE"
    assert extract("car accident, two cars collided").incident_type == "TRAFFIC"
    assert extract("someone robbed me").incident_type == "CRIME"
    assert extract("hello can you help").incident_type == "UNKNOWN"


def test_dialect_and_code_switch():
    assert detect_lang("شلون الحين").dialect == "gulf"
    assert detect_lang("هلق كتير").dialect == "levantine"
    assert detect_lang("دلوقتي عايز").dialect == "egyptian"
    li = detect_lang("الحريق في building الان")
    assert li.lang == "mixed" and li.code_switched
    assert detect_lang("help me").lang == "en"


@pytest.mark.parametrize("text,name", [
    ("we are on Shaikh Zaid road", "Sheikh Zayed Road"), ("near dera", "Deira"), ("بالكرامة", "Al Karama"),
    ("في شارع الشيخ زايد", "Sheikh Zayed Road"), ("I'm at the mall of emirates", "Mall of the Emirates"),
])
def test_location_fuzzy(text, name):
    assert LocationEngine().resolve(text)[0].name == name


def test_location_no_false_positive_and_aml_fusion():
    L = LocationEngine()
    assert L.resolve("I need help at my house please") == []
    c = L.resolve("al wasl road", {"lat": 25.2008, "lon": 55.2458, "accuracy_m": 40})
    assert c[0].name == "Al Wasl Road" and "corroborated" in c[0].note
    far = L.resolve("al wasl road", {"lat": 25.5, "lon": 55.6, "accuracy_m": 40})
    assert far[0].source == "aml" and "conflicts" in next(x for x in far if x.source == "speech").note
    assert L.resolve("nothing here", {"lat": 25.2, "lon": 55.2, "accuracy_m": 50})[0].source == "aml"
