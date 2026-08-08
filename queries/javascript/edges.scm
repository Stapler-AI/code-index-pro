; Relationships → edges rows (ast-graph.md#edge-model).
; Captures prefixed with an underscore (@_x) exist only to anchor predicates;
; extraction ignores them.

; calls — callee identifier, or the property name for obj.method()
; (name-only; see indexing.md#known-limitations)
(call_expression
  function: (identifier) @call.callee)

(call_expression
  function: (member_expression
    property: (property_identifier) @call.method))

; imports — one match per specifier; @import.source is the module string
(import_statement
  (import_clause
    (identifier) @import.default)
  source: (string) @import.source)

(import_statement
  (import_clause
    (named_imports
      (import_specifier) @import.specifier))
  source: (string) @import.source)

(import_statement
  (import_clause
    (namespace_import
      (identifier) @import.namespace))
  source: (string) @import.source)

; exports — ESM
(export_statement
  declaration: (_) @export.declaration)

(export_statement
  (export_clause
    (export_specifier) @export.specifier))

; export default <expression> — the value: field, distinct from wrapped
; declarations (export default function f() {} takes the declaration: arm)
(export_statement
  value: (_) @export.default)

; re-export source (export … from './x')
(export_statement
  source: (string) @export.source)

; exports — CJS: module.exports = …, module.exports.name = …, exports.name = …
(assignment_expression
  left: (member_expression
    object: (identifier) @_cjs_object
    property: (property_identifier) @_cjs_property)
  (#eq? @_cjs_object "module")
  (#eq? @_cjs_property "exports")) @export.cjs_module

(assignment_expression
  left: (member_expression
    object: (member_expression
      object: (identifier) @_cjs_object
      property: (property_identifier) @_cjs_property)
    property: (property_identifier) @export.cjs_name)
  (#eq? @_cjs_object "module")
  (#eq? @_cjs_property "exports")) @export.cjs_named

(assignment_expression
  left: (member_expression
    object: (identifier) @_exports_object
    property: (property_identifier) @export.cjs_name)
  (#eq? @_exports_object "exports")) @export.cjs_named

; extends — JS heritage holds a bare expression; the source class is the
; innermost enclosing symbol of the captured name
(class_heritage
  (identifier) @extends.name)

(class_heritage
  (member_expression
    property: (property_identifier) @extends.name))

; references — candidate identifier uses (callbacks, aliases); extraction
; filters these against known symbol names
(arguments
  (identifier) @reference.identifier)

(variable_declarator
  value: (identifier) @reference.identifier)
