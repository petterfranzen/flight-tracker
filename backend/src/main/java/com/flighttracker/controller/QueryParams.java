package com.flighttracker.controller;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Marks a record handler argument whose components are query parameters,
 * each declared on the component with its own {@code @RequestParam}
 * (name, default, required) and resolved by {@link QueryParamsResolver}
 * exactly as that {@code @RequestParam} would be on the handler itself.
 * Unlike {@code @ModelAttribute} there is no data binding: request
 * headers, {@code _}/{@code !}-prefixed and indexed names are never read.
 */
@Target(ElementType.PARAMETER)
@Retention(RetentionPolicy.RUNTIME)
@Documented
public @interface QueryParams {
}
