use scraper::{Html};
use std::collections::HashMap;
use napi_derive::napi;

#[derive(Clone)]
pub struct ElementData {
  pub tag_name: String,
  pub attributes: HashMap<String, String>,
}

#[derive(Clone)]
pub enum NodeData {
  Document,
  Element(ElementData),
  Text(String),
  Comment(String),
  Doctype,
}

#[derive(Clone)]
pub struct ArenaNode {
  pub id: u32,
  pub parent: Option<u32>,
  pub children: Vec<u32>,
  pub data: NodeData,
}

#[napi]
pub struct RustDocument {
  nodes: Vec<ArenaNode>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Combinator {
  Descendant,
  Child,
  Adjacent,
  General,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum AttrMatchType {
  Exact,
  StartsWith,
  EndsWith,
  Contains,
  Exists,
}

#[derive(Debug, Clone)]
pub struct AttributeMatch {
  pub name: String,
  pub value: String,
  pub match_type: AttrMatchType,
}

#[derive(Debug, Clone)]
pub struct SelectorPart {
  pub tag_name: Option<String>,
  pub id: Option<String>,
  pub classes: Vec<String>,
  pub attributes: Vec<AttributeMatch>,
  pub first_child: bool,
  pub last_child: bool,
  pub empty: bool,
  pub nth_child: Option<u32>,
}

impl SelectorPart {
  fn commit(&mut self, state: char, token: &str) {
    if token.is_empty() { return; }
    match state {
      't' => self.tag_name = Some(token.to_lowercase()),
      'i' => self.id = Some(token.to_string()),
      'c' => self.classes.push(token.to_string()),
      'p' => {
        let tok = token.to_lowercase();
        if tok == "first-child" {
          self.first_child = true;
        } else if tok == "last-child" {
          self.last_child = true;
        } else if tok == "empty" {
          self.empty = true;
        } else if tok.starts_with("nth-child(") && tok.ends_with(')') {
          let inner = &tok[10..tok.len()-1];
          if let Ok(idx) = inner.parse::<u32>() {
            self.nth_child = Some(idx);
          }
        }
      }
      _ => {}
    }
  }

  fn commit_attr(&mut self, token: &str) {
    let token = token.trim();
    if token.is_empty() { return; }
    
    let mut match_type = AttrMatchType::Exists;
    let mut name = token.to_string();
    let mut value = String::new();
    
    if let Some(pos) = token.find("^=") {
      match_type = AttrMatchType::StartsWith;
      name = token[..pos].trim().to_string();
      value = token[pos+2..].trim().to_string();
    } else if let Some(pos) = token.find("$=") {
      match_type = AttrMatchType::EndsWith;
      name = token[..pos].trim().to_string();
      value = token[pos+2..].trim().to_string();
    } else if let Some(pos) = token.find("*=") {
      match_type = AttrMatchType::Contains;
      name = token[..pos].trim().to_string();
      value = token[pos+2..].trim().to_string();
    } else if let Some(pos) = token.find('=') {
      match_type = AttrMatchType::Exact;
      name = token[..pos].trim().to_string();
      value = token[pos+1..].trim().to_string();
    }
    
    if match_type != AttrMatchType::Exists {
      if value.starts_with('"') || value.starts_with('\'') {
        value.remove(0);
      }
      if value.ends_with('"') || value.ends_with('\'') {
        value.pop();
      }
    }
    
    self.attributes.push(AttributeMatch { name, value, match_type });
  }
}

#[derive(Debug, Clone)]
pub struct SelectorStep {
  pub part: SelectorPart,
  pub combinator: Option<Combinator>,
}

fn parse_selectors(selector_str: &str) -> Option<Vec<SelectorStep>> {
  let mut normalized = selector_str.to_string();
  normalized = normalized.replace(">", " > ");
  normalized = normalized.replace("+", " + ");
  normalized = normalized.replace("~", " ~ ");
  
  let tokens: Vec<&str> = normalized.split_whitespace().collect();
  if tokens.is_empty() { return None; }
  
  let mut steps = Vec::new();
  let mut i = 0;
  
  while i < tokens.len() {
    let token = tokens[i];
    if token == ">" || token == "+" || token == "~" {
      return None;
    }
    
    let mut part = SelectorPart {
      tag_name: None,
      id: None,
      classes: Vec::new(),
      attributes: Vec::new(),
      first_child: false,
      last_child: false,
      empty: false,
      nth_child: None,
    };
    
    let mut chars = token.chars().peekable();
    let mut current_token = String::new();
    let mut state = 't';
    
    while let Some(c) = chars.next() {
      if c == '#' && state != 'a' {
        part.commit(state, &current_token);
        current_token.clear();
        state = 'i';
      } else if c == '.' && state != 'a' {
        part.commit(state, &current_token);
        current_token.clear();
        state = 'c';
      } else if c == ':' && state != 'a' {
        part.commit(state, &current_token);
        current_token.clear();
        state = 'p';
      } else if c == '[' && state != 'a' {
        part.commit(state, &current_token);
        current_token.clear();
        state = 'a';
      } else if c == ']' && state == 'a' {
        part.commit_attr(&current_token);
        current_token.clear();
        state = 'x';
      } else {
        if state != 'x' {
          current_token.push(c);
        }
      }
    }
    part.commit(state, &current_token);
    
    let mut combinator = None;
    if i + 1 < tokens.len() {
      let next_token = tokens[i + 1];
      if next_token == ">" || next_token == "+" || next_token == "~" {
        combinator = Some(match next_token {
          ">" => Combinator::Child,
          "+" => Combinator::Adjacent,
          "~" => Combinator::General,
          _ => Combinator::Descendant,
        });
        i += 2;
      } else {
        combinator = Some(Combinator::Descendant);
        i += 1;
      }
    } else {
      i += 1;
    }
    
    steps.push(SelectorStep { part, combinator });
  }
  
  let mut reversed_steps = Vec::new();
  for j in (0..steps.len()).rev() {
    let mut step = steps[j].clone();
    if j > 0 {
      step.combinator = steps[j - 1].combinator;
    } else {
      step.combinator = None;
    }
    reversed_steps.push(step);
  }
  
  Some(reversed_steps)
}

impl RustDocument {
  pub fn new_parsed(content: String) -> Self {
    let html = Html::parse_document(&content);
    let mut doc = RustDocument { nodes: Vec::new() };
    let root = html.tree.root();
    doc.build_from_scraper(root, None);
    doc
  }
  
  fn build_from_scraper(&mut self, scraper_node: ego_tree::NodeRef<scraper::Node>, parent_id: Option<u32>) -> u32 {
    let next_id = self.nodes.len() as u32;
    let arena_node = ArenaNode {
      id: next_id,
      parent: parent_id,
      children: Vec::new(),
      data: NodeData::Doctype,
    };
    self.nodes.push(arena_node);
    
    let data = match scraper_node.value() {
      scraper::Node::Document => NodeData::Document,
      scraper::Node::Fragment => NodeData::Document,
      scraper::Node::Doctype(_) => NodeData::Doctype,
      scraper::Node::Comment(c) => NodeData::Comment(c.comment.to_string()),
      scraper::Node::Text(t) => NodeData::Text(t.text.to_string()),
      scraper::Node::Element(e) => {
        let mut attributes = HashMap::new();
        for (name, val) in e.attrs() {
          attributes.insert(name.to_string(), val.to_string());
        }
        NodeData::Element(ElementData {
          tag_name: e.name().to_string(),
          attributes,
        })
      }
      _ => NodeData::Doctype,
    };
    
    self.nodes[next_id as usize].data = data;
    
    let mut child_ids = Vec::new();
    for child in scraper_node.children() {
      let child_id = self.build_from_scraper(child, Some(next_id));
      child_ids.push(child_id);
    }
    
    self.nodes[next_id as usize].children = child_ids;
    next_id
  }

  fn get_previous_sibling_element(&self, node_id: u32) -> Option<u32> {
    let parent_id = self.nodes[node_id as usize].parent?;
    let parent = &self.nodes[parent_id as usize];
    let pos = parent.children.iter().position(|&x| x == node_id)?;
    for i in (0..pos).rev() {
      let sib_id = parent.children[i];
      if let NodeData::Element(_) = &self.nodes[sib_id as usize].data {
        return Some(sib_id);
      }
    }
    None
  }

  fn match_part(&self, node_id: u32, part: &SelectorPart) -> bool {
    let node = &self.nodes[node_id as usize];
    match &node.data {
      NodeData::Element(elem) => {
        if let Some(ref tag) = part.tag_name {
          if elem.tag_name != *tag {
            return false;
          }
        }
        if let Some(ref id) = part.id {
          if elem.attributes.get("id") != Some(id) {
            return false;
          }
        }
        for class in &part.classes {
          if let Some(classes_str) = elem.attributes.get("class") {
            let has_class = classes_str.split_whitespace().any(|c| c == class);
            if !has_class {
              return false;
            }
          } else {
            return false;
          }
        }
        for attr_match in &part.attributes {
          if let Some(actual_val) = elem.attributes.get(&attr_match.name) {
            match attr_match.match_type {
              AttrMatchType::Exists => {}
              AttrMatchType::Exact => {
                if actual_val != &attr_match.value {
                  return false;
                }
              }
              AttrMatchType::StartsWith => {
                if !actual_val.starts_with(&attr_match.value) {
                  return false;
                }
              }
              AttrMatchType::EndsWith => {
                if !actual_val.ends_with(&attr_match.value) {
                  return false;
                }
              }
              AttrMatchType::Contains => {
                if !actual_val.contains(&attr_match.value) {
                  return false;
                }
              }
            }
          } else {
            return false;
          }
        }
        if part.first_child {
          if let Some(parent_id) = node.parent {
            let parent = &self.nodes[parent_id as usize];
            let first_elem_id = parent.children.iter().find(|&&child_id| {
              matches!(&self.nodes[child_id as usize].data, NodeData::Element(_))
            });
            if first_elem_id != Some(&node_id) {
              return false;
            }
          } else {
            return false;
          }
        }
        if part.last_child {
          if let Some(parent_id) = node.parent {
            let parent = &self.nodes[parent_id as usize];
            let last_elem_id = parent.children.iter().rev().find(|&&child_id| {
              matches!(&self.nodes[child_id as usize].data, NodeData::Element(_))
            });
            if last_elem_id != Some(&node_id) {
              return false;
            }
          } else {
            return false;
          }
        }
        if part.empty {
          if !node.children.is_empty() {
            return false;
          }
        }
        if let Some(nth) = part.nth_child {
          if let Some(parent_id) = node.parent {
            let parent = &self.nodes[parent_id as usize];
            let mut element_index = 0;
            let mut found = false;
            for &child_id in &parent.children {
              if matches!(&self.nodes[child_id as usize].data, NodeData::Element(_)) {
                element_index += 1;
                if child_id == node_id {
                  if element_index == nth {
                    found = true;
                  }
                  break;
                }
              }
            }
            if !found {
              return false;
            }
          } else {
            return false;
          }
        }
        true
      }
      _ => false,
    }
  }

  fn match_selector(&self, node_id: u32, steps: &[SelectorStep]) -> bool {
    if steps.is_empty() { return false; }
    if !self.match_part(node_id, &steps[0].part) {
      return false;
    }
    
    let mut current_node_id = node_id;
    for i in 0..steps.len() - 1 {
      let relation = steps[i].combinator.unwrap_or(Combinator::Descendant);
      let next_part = &steps[i + 1].part;
      
      match relation {
        Combinator::Child => {
          if let Some(parent_id) = self.nodes[current_node_id as usize].parent {
            current_node_id = parent_id;
            if !self.match_part(current_node_id, next_part) {
              return false;
            }
          } else {
            return false;
          }
        }
        Combinator::Descendant => {
          let mut matched = false;
          while let Some(parent_id) = self.nodes[current_node_id as usize].parent {
            current_node_id = parent_id;
            if self.match_part(current_node_id, next_part) {
              matched = true;
              break;
            }
          }
          if !matched {
            return false;
          }
        }
        Combinator::Adjacent => {
          if let Some(prev_sibling_id) = self.get_previous_sibling_element(current_node_id) {
            current_node_id = prev_sibling_id;
            if !self.match_part(current_node_id, next_part) {
              return false;
            }
          } else {
            return false;
          }
        }
        Combinator::General => {
          let mut matched = false;
          while let Some(prev_sibling_id) = self.get_previous_sibling_element(current_node_id) {
            current_node_id = prev_sibling_id;
            if self.match_part(current_node_id, next_part) {
              matched = true;
              break;
            }
          }
          if !matched {
            return false;
          }
        }
      }
    }
    true
  }

  fn query_selector_all_internal(&self, start_node_id: u32, steps: &[SelectorStep]) -> Vec<u32> {
    let mut results = Vec::new();
    let mut stack = vec![start_node_id];
    while let Some(node_id) = stack.pop() {
      if node_id != start_node_id {
        if self.match_selector(node_id, steps) {
          results.push(node_id);
        }
      }
      let node = &self.nodes[node_id as usize];
      for &child_id in node.children.iter().rev() {
        stack.push(child_id);
      }
    }
    results
  }

  pub fn text_content(&self, node_id: u32) -> String {
    let mut result = String::new();
    self.text_content_to(&mut result, node_id);
    result
  }
  
  fn text_content_to(&self, out: &mut String, node_id: u32) {
    if let Some(node) = self.nodes.get(node_id as usize) {
      match &node.data {
        NodeData::Text(t) => {
          out.push_str(t);
        }
        _ => {
          for &child_id in &node.children {
            self.text_content_to(out, child_id);
          }
        }
      }
    }
  }

  pub fn inner_html(&self, node_id: u32) -> String {
    let mut result = String::new();
    if let Some(node) = self.nodes.get(node_id as usize) {
      for &child_id in &node.children {
        self.serialize_node_to(&mut result, child_id);
      }
    }
    result
  }

  pub fn serialize_node(&self, node_id: u32) -> String {
    let mut result = String::new();
    self.serialize_node_to(&mut result, node_id);
    result
  }
  
  fn serialize_node_to(&self, out: &mut String, node_id: u32) {
    if let Some(node) = self.nodes.get(node_id as usize) {
      match &node.data {
        NodeData::Document => {
          for &child_id in &node.children {
            self.serialize_node_to(out, child_id);
          }
        }
        NodeData::Doctype => {
          out.push_str("<!DOCTYPE html>");
        }
        NodeData::Comment(c) => {
          out.push_str("<!--");
          out.push_str(c);
          out.push_str("-->");
        }
        NodeData::Text(t) => {
          out.push_str(t);
        }
        NodeData::Element(e) => {
          out.push_str("<");
          out.push_str(&e.tag_name);
          for (name, val) in &e.attributes {
            out.push_str(" ");
            out.push_str(name);
            out.push_str("=\"");
            out.push_str(val);
            out.push_str("\"");
          }
          
          let self_closing = matches!(
            e.tag_name.as_str(),
            "area" | "base" | "br" | "col" | "embed" | "hr" | "img" | "input" | "link" | "meta" | "param" | "source" | "track" | "wbr"
          );
          
          if self_closing {
            out.push_str(" />");
          } else {
            out.push_str(">");
            for &child_id in &node.children {
              self.serialize_node_to(out, child_id);
            }
            out.push_str("</");
            out.push_str(&e.tag_name);
            out.push_str(">");
          }
        }
      }
    }
  }

  fn clone_node_internal(&mut self, node_id: u32, deep: bool, parent_id: Option<u32>) -> u32 {
    let next_id = self.nodes.len() as u32;
    let node_data = self.nodes[node_id as usize].data.clone();
    
    let cloned_node = ArenaNode {
      id: next_id,
      parent: parent_id,
      children: Vec::new(),
      data: node_data,
    };
    self.nodes.push(cloned_node);
    
    if deep {
      let mut cloned_children = Vec::new();
      let children_ids: Vec<u32> = self.nodes[node_id as usize].children.clone();
      for child_id in children_ids {
        let cloned_child_id = self.clone_node_internal(child_id, deep, Some(next_id));
        cloned_children.push(cloned_child_id);
      }
      self.nodes[next_id as usize].children = cloned_children;
    }
    
    next_id
  }
}

#[napi]
impl RustDocument {
  #[napi(constructor)]
  pub fn new(content: String) -> Self {
    RustDocument::new_parsed(content)
  }
  
  #[napi]
  pub fn query_selector(&self, node_id: u32, selector_str: String) -> Option<u32> {
    let steps = parse_selectors(&selector_str)?;
    let mut stack = vec![node_id];
    while let Some(current_id) = stack.pop() {
      if current_id != node_id && self.match_selector(current_id, &steps) {
        return Some(current_id);
      }
      if let Some(node) = self.nodes.get(current_id as usize) {
        for &child_id in node.children.iter().rev() {
          stack.push(child_id);
        }
      }
    }
    None
  }

  #[napi]
  pub fn query_selector_all(&self, node_id: u32, selector_str: String) -> Vec<u32> {
    if let Some(steps) = parse_selectors(&selector_str) {
      self.query_selector_all_internal(node_id, &steps)
    } else {
      vec![]
    }
  }

  #[napi]
  pub fn get_element_by_id(&self, node_id: u32, id: String) -> Option<u32> {
    let mut stack = vec![node_id];
    while let Some(current_id) = stack.pop() {
      if current_id != node_id {
        if let Some(node) = self.nodes.get(current_id as usize) {
          if let NodeData::Element(e) = &node.data {
            if e.attributes.get("id") == Some(&id) {
              return Some(current_id);
            }
          }
        }
      }
      if let Some(node) = self.nodes.get(current_id as usize) {
        for &child_id in node.children.iter().rev() {
          stack.push(child_id);
        }
      }
    }
    None
  }

  #[napi]
  pub fn get_elements_by_class_name(&self, node_id: u32, class_name: String) -> Vec<u32> {
    let mut results = Vec::new();
    let mut stack = vec![node_id];
    let target_classes: Vec<&str> = class_name.split_whitespace().collect();
    if target_classes.is_empty() { return results; }
    
    while let Some(current_id) = stack.pop() {
      if current_id != node_id {
        if let Some(node) = self.nodes.get(current_id as usize) {
          if let NodeData::Element(e) = &node.data {
            if let Some(class_str) = e.attributes.get("class") {
              let actual_classes: Vec<&str> = class_str.split_whitespace().collect();
              let all_match = target_classes.iter().all(|&tc| actual_classes.contains(&tc));
              if all_match {
                results.push(current_id);
              }
            }
          }
        }
      }
      if let Some(node) = self.nodes.get(current_id as usize) {
        for &child_id in node.children.iter().rev() {
          stack.push(child_id);
        }
      }
    }
    results
  }

  #[napi]
  pub fn get_elements_by_tag_name(&self, node_id: u32, tag_name: String) -> Vec<u32> {
    let mut results = Vec::new();
    let mut stack = vec![node_id];
    let tag_lower = tag_name.to_lowercase();
    let match_all = tag_lower == "*";
    
    while let Some(current_id) = stack.pop() {
      if current_id != node_id {
        if let Some(node) = self.nodes.get(current_id as usize) {
          if let NodeData::Element(e) = &node.data {
            if match_all || e.tag_name.to_lowercase() == tag_lower {
              results.push(current_id);
            }
          }
        }
      }
      if let Some(node) = self.nodes.get(current_id as usize) {
        for &child_id in node.children.iter().rev() {
          stack.push(child_id);
        }
      }
    }
    results
  }

  #[napi]
  pub fn get_tag_name(&self, node_id: u32) -> Option<String> {
    let node = self.nodes.get(node_id as usize)?;
    match &node.data {
      NodeData::Element(e) => Some(e.tag_name.clone()),
      _ => None,
    }
  }

  #[napi]
  pub fn get_text_content(&self, node_id: u32) -> Option<String> {
    if node_id as usize >= self.nodes.len() { return None; }
    Some(self.text_content(node_id))
  }

  #[napi]
  pub fn set_text_content(&mut self, node_id: u32, text: String) {
    if (node_id as usize) >= self.nodes.len() { return; }
    
    let old_children = std::mem::take(&mut self.nodes[node_id as usize].children);
    for child_id in old_children {
      if let Some(child) = self.nodes.get_mut(child_id as usize) {
        child.parent = None;
      }
    }
    
    let next_id = self.nodes.len() as u32;
    let text_node = ArenaNode {
      id: next_id,
      parent: Some(node_id),
      children: Vec::new(),
      data: NodeData::Text(text),
    };
    self.nodes.push(text_node);
    self.nodes[node_id as usize].children.push(next_id);
  }

  #[napi]
  pub fn get_node_value(&self, node_id: u32) -> Option<String> {
    let node = self.nodes.get(node_id as usize)?;
    match &node.data {
      NodeData::Text(t) => Some(t.clone()),
      NodeData::Comment(c) => Some(c.clone()),
      _ => None,
    }
  }

  #[napi]
  pub fn set_node_value(&mut self, node_id: u32, value: Option<String>) {
    if let Some(node) = self.nodes.get_mut(node_id as usize) {
      let val = value.unwrap_or_default();
      match &mut node.data {
        NodeData::Text(t) => *t = val,
        NodeData::Comment(c) => *c = val,
        _ => {}
      }
    }
  }

  #[napi]
  pub fn get_inner_html(&self, node_id: u32) -> Option<String> {
    if node_id as usize >= self.nodes.len() { return None; }
    Some(self.inner_html(node_id))
  }

  #[napi]
  pub fn set_inner_html(&mut self, node_id: u32, html: String) {
    if (node_id as usize) >= self.nodes.len() { return; }
    
    let old_children = std::mem::take(&mut self.nodes[node_id as usize].children);
    for child_id in old_children {
      if let Some(child) = self.nodes.get_mut(child_id as usize) {
        child.parent = None;
      }
    }
    
    let fragment = Html::parse_fragment(&html);
    let root = fragment.tree.root();
    for child in root.children() {
      let child_id = self.build_from_scraper(child, Some(node_id));
      self.nodes[node_id as usize].children.push(child_id);
    }
  }

  #[napi]
  pub fn get_outer_html(&self, node_id: u32) -> Option<String> {
    if node_id as usize >= self.nodes.len() { return None; }
    Some(self.serialize_node(node_id))
  }

  #[napi]
  pub fn get_attribute(&self, node_id: u32, name: String) -> Option<String> {
    let node = self.nodes.get(node_id as usize)?;
    match &node.data {
      NodeData::Element(e) => e.attributes.get(&name).cloned(),
      _ => None,
    }
  }

  #[napi]
  pub fn set_attribute(&mut self, node_id: u32, name: String, value: String) {
    if let Some(node) = self.nodes.get_mut(node_id as usize) {
      if let NodeData::Element(ref mut e) = node.data {
        e.attributes.insert(name, value);
      }
    }
  }

  #[napi]
  pub fn remove_attribute(&mut self, node_id: u32, name: String) {
    if let Some(node) = self.nodes.get_mut(node_id as usize) {
      if let NodeData::Element(ref mut e) = node.data {
        e.attributes.remove(&name);
      }
    }
  }

  #[napi]
  pub fn get_attributes(&self, node_id: u32) -> HashMap<String, String> {
    if let Some(node) = self.nodes.get(node_id as usize) {
      if let NodeData::Element(e) = &node.data {
        return e.attributes.clone();
      }
    }
    HashMap::new()
  }

  #[napi]
  pub fn get_parent_node(&self, node_id: u32) -> Option<u32> {
    let node = self.nodes.get(node_id as usize)?;
    node.parent
  }

  #[napi]
  pub fn get_child_nodes(&self, node_id: u32) -> Vec<u32> {
    if let Some(node) = self.nodes.get(node_id as usize) {
      node.children.clone()
    } else {
      vec![]
    }
  }

  #[napi]
  pub fn append_child(&mut self, parent_id: u32, child_id: u32) {
    if (parent_id as usize) < self.nodes.len() && (child_id as usize) < self.nodes.len() {
      if let Some(child) = self.nodes.get(child_id as usize) {
        if let Some(old_parent) = child.parent {
          self.remove_child(old_parent, child_id);
        }
      }
      if let Some(child) = self.nodes.get_mut(child_id as usize) {
        child.parent = Some(parent_id);
      }
      if let Some(parent) = self.nodes.get_mut(parent_id as usize) {
        parent.children.push(child_id);
      }
    }
  }

  #[napi]
  pub fn remove_child(&mut self, parent_id: u32, child_id: u32) -> Option<u32> {
    if (parent_id as usize) < self.nodes.len() && (child_id as usize) < self.nodes.len() {
      if let Some(parent) = self.nodes.get_mut(parent_id as usize) {
        if let Some(pos) = parent.children.iter().position(|&x| x == child_id) {
          parent.children.remove(pos);
        }
      }
      if let Some(child) = self.nodes.get_mut(child_id as usize) {
        child.parent = None;
      }
      Some(child_id)
    } else {
      None
    }
  }

  #[napi]
  pub fn insert_before(&mut self, parent_id: u32, child_id: u32, ref_id: Option<u32>) {
    if (parent_id as usize) < self.nodes.len() && (child_id as usize) < self.nodes.len() {
      if let Some(child) = self.nodes.get(child_id as usize) {
        if let Some(old_parent) = child.parent {
          self.remove_child(old_parent, child_id);
        }
      }
      
      if let Some(child) = self.nodes.get_mut(child_id as usize) {
        child.parent = Some(parent_id);
      }
      
      if let Some(parent) = self.nodes.get_mut(parent_id as usize) {
        if let Some(ref_val) = ref_id {
          if let Some(pos) = parent.children.iter().position(|&x| x == ref_val) {
            parent.children.insert(pos, child_id);
            return;
          }
        }
        parent.children.push(child_id);
      }
    }
  }

  #[napi]
  pub fn replace_child(&mut self, parent_id: u32, new_child_id: u32, old_child_id: u32) -> Option<u32> {
    if (parent_id as usize) < self.nodes.len() && (new_child_id as usize) < self.nodes.len() && (old_child_id as usize) < self.nodes.len() {
      if let Some(child) = self.nodes.get(new_child_id as usize) {
        if let Some(old_parent) = child.parent {
          self.remove_child(old_parent, new_child_id);
        }
      }
      
      let mut found_pos = None;
      if let Some(parent) = self.nodes.get(parent_id as usize) {
        if let Some(pos) = parent.children.iter().position(|&x| x == old_child_id) {
          found_pos = Some(pos);
        }
      }
      
      if let Some(pos) = found_pos {
        if let Some(old_child) = self.nodes.get_mut(old_child_id as usize) {
          old_child.parent = None;
        }
        if let Some(parent) = self.nodes.get_mut(parent_id as usize) {
          parent.children[pos] = new_child_id;
        }
        if let Some(new_child) = self.nodes.get_mut(new_child_id as usize) {
          new_child.parent = Some(parent_id);
        }
        return Some(old_child_id);
      }
    }
    None
  }

  #[napi]
  pub fn clone_node(&mut self, node_id: u32, deep: bool) -> Option<u32> {
    if (node_id as usize) >= self.nodes.len() { return None; }
    let cloned_id = self.clone_node_internal(node_id, deep, None);
    Some(cloned_id)
  }

  #[napi]
  pub fn create_element(&mut self, tag_name: String) -> u32 {
    let next_id = self.nodes.len() as u32;
    let node = ArenaNode {
      id: next_id,
      parent: None,
      children: Vec::new(),
      data: NodeData::Element(ElementData {
        tag_name,
        attributes: HashMap::new(),
      }),
    };
    self.nodes.push(node);
    next_id
  }

  #[napi]
  pub fn create_text_node(&mut self, text: String) -> u32 {
    let next_id = self.nodes.len() as u32;
    let node = ArenaNode {
      id: next_id,
      parent: None,
      children: Vec::new(),
      data: NodeData::Text(text),
    };
    self.nodes.push(node);
    next_id
  }
}
