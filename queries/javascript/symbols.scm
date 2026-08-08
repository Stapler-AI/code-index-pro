; Declarations → symbols rows (ast-graph.md#node-model).
; Contract: each pattern captures the declaration node as @definition.<kind>
; and its name node as @name. Extraction (FR-302) maps kind, assembles the
; signature, and decides exported status from surrounding context.

(function_declaration
  name: (identifier) @name) @definition.function

(generator_function_declaration
  name: (identifier) @name) @definition.function

(class_declaration
  name: (identifier) @name) @definition.class

(method_definition
  name: (property_identifier) @name) @definition.method

; Top-level and export-wrapped const/let/var declarators. Function-local
; variables are deliberately not captured — they never become symbols.
(program
  (lexical_declaration
    (variable_declarator
      name: (identifier) @name) @definition.variable))

(program
  (variable_declaration
    (variable_declarator
      name: (identifier) @name) @definition.variable))

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name) @definition.variable))

(export_statement
  declaration: (variable_declaration
    (variable_declarator
      name: (identifier) @name) @definition.variable))
