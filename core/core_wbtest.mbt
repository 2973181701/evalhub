// Whitebox tests run within the package scope.
// Use them to validate internal helpers or invariants.
// Keep them focused; public behavior belongs in `_test.mbt`.

///|
test "smoke: test infra works" {
  assert_eq(1 + 1, 2)
}
